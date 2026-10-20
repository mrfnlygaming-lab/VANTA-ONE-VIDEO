import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function ensureTools(root) {
  const manifest = JSON.parse(await readFile(new URL('./desktop-tools.json', import.meta.url), 'utf8'));
  const platform = `${process.platform}-${process.arch}`;
  const entries = manifest.platforms[platform];
  if (!entries) throw new Error(`No bundled video tools for ${platform}. Use Windows x64, macOS x64/arm64, or Linux x64/arm64.`);
  const folder = path.join(root, '.vanta-runtime', 'tools', manifest.ffmpegRelease, platform);
  await mkdir(folder, { recursive: true });
  const tools = {};
  for (const [name, asset] of Object.entries(entries)) {
    const file = path.join(folder, name + (process.platform === 'win32' && ['ffmpeg', 'ffprobe'].includes(name) ? '.exe' : ''));
    let valid = false;
    try { valid = await digest(file) === asset.sha256; } catch { /* Download a missing cache entry. */ }
    if (!valid) {
      console.log(`Downloading verified video tool: ${name}…`);
      const partial = `${file}.partial`;
      try {
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(180_000) });
        if (!response.ok || !response.body || !response.url.startsWith('https:'))
          throw new Error(`Download failed (HTTP ${response.status}).`);
        let bytes = 0;
        const bounded = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > 200 * 1024 * 1024 ? new Error('Video tool download is too large.') : null, chunk);
        }});
        await pipeline(Readable.fromWeb(response.body), bounded, createWriteStream(partial, { mode: 0o600 }));
        if (await digest(partial) !== asset.sha256) throw new Error(`Checksum verification failed for ${name}.`);
        await rename(partial, file);
      } finally {
        await rm(partial, { force: true });
      }
    }
    if (['ffmpeg', 'ffprobe'].includes(name)) {
      if (process.platform !== 'win32') await chmod(file, 0o755);
      tools[`${name}Path`] = file;
    }
  }
  return tools;
}
