import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ensureTools } from './desktop-tools.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = path.join(root, '.vanta-runtime');
const args = process.argv.slice(2);
let server, app, stopping = false;

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Dependency setup exited with code ${code}. Check your internet connection and try again.`)));
  });
}

async function installDependencies() {
  const lock = await readFile(path.join(root, 'package-lock.json'));
  const fingerprint = createHash('sha256').update(lock).digest('hex');
  const marker = path.join(runtime, 'dependencies.sha256');
  try {
    if ((await readFile(marker, 'utf8')) === fingerprint) {
      await access(path.join(root, 'node_modules', 'express', 'package.json'));
      await access(path.join(root, 'node_modules', 'multer', 'package.json'));
      return;
    }
  } catch { /* A clean install is needed. */ }
  console.log('Installing app dependencies with the locked checksums…');
  const executableFolder = path.dirname(process.execPath);
  const candidates = [
    path.join(executableFolder, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableFolder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  try { candidates.push(createRequire(import.meta.url).resolve('npm/bin/npm-cli.js')); } catch { /* Portable paths or PATH are checked next. */ }
  let npmCli;
  for (const candidate of candidates) {
    try { await access(candidate); npmCli = candidate; break; } catch { /* Try next path. */ }
  }
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  const npmArgs = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--cache', path.join(runtime, 'npm-cache')];
  if (npmCli) await run(process.execPath, ['--use-env-proxy', '--use-system-ca', npmCli, ...npmArgs], { env });
  else if (process.platform !== 'win32') await run('npm', npmArgs, { env });
  else throw new Error('The Node installation is missing npm. Remove .vanta-runtime/node and launch again to download the complete runtime.');
  await writeFile(marker, fingerprint);
}

async function getKey() {
  if (process.env.XAI_API_KEY?.trim()) return process.env.XAI_API_KEY.trim();
  if (!process.stdin.isTTY) throw new Error('Start VANTA from its desktop launcher to enter your xAI API key privately, or set XAI_API_KEY in your local environment. Never put a key in chat.');
  console.log('\nAI generation uses your xAI API credits. The key stays in this server process and is not saved to a file.');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  input.once('SIGINT', () => {
    input.close();
    process.stdout.write('\nStartup canceled.\n');
    process.exit(0);
  });
  try {
    const answer = input.question('');
    process.stdout.write('Enter your xAI API key (hidden), then press Enter: ');
    const key = (await answer).trim();
    process.stdout.write('\n');
    if (!key) throw new Error('An xAI API key is required for AI scenes. Run the launcher again when you have your key.');
    return key;
  } finally { input.close(); }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  server?.close();
  if (app) await Promise.allSettled([app.locals.videoService.close(), app.locals.aiService.close()]);
  server?.closeAllConnections();
  process.exit(0);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) throw new Error('Node.js 24.5 or newer is required. Use the supplied desktop launcher.');
  const portIndex = args.indexOf('--port');
  const port = portIndex < 0 ? 0 : Number(args[portIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid local port.');
  await access(path.join(root, 'dist', 'index.html'));
  await mkdir(runtime, { recursive: true });
  await installDependencies();
  const tools = await ensureTools(root);
  for (const tool of Object.values(tools)) {
    const result = spawnSync(tool, ['-version'], { stdio: 'ignore', timeout: 15_000 });
    if (result.status !== 0) throw new Error('A video tool cannot run on this computer. Check START-HERE.txt for supported platforms.');
  }
  process.env.XAI_API_KEY = await getKey();
  const { createApp } = await import('../server/index.js');
  app = await createApp({ ...tools, dataDir: path.join(root, '.data') });
  server = await new Promise((resolve, reject) => {
    const listener = createServer((req, res) => {
      const host = `127.0.0.1:${listener.address().port}`;
      if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Open VANTA from its local launcher to use this server.' }));
        return;
      }
      app(req, res);
    });
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', () => resolve(listener));
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nVANTA is running on your computer: ${url}`);
  console.log('Keep this terminal open. Press Ctrl+C here to stop. AI generation starts only when you select Generate AI scene.');
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    opener.on('error', () => console.log(`Open the address above in your browser.`));
    opener.unref();
  }
} catch (error) {
  console.error(`\nVANTA could not start: ${error.message}`);
  if (app) await Promise.allSettled([app.locals.videoService.close(), app.locals.aiService.close()]);
  server?.close();
  process.exitCode = 1;
}
