import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
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
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Setup exited with code ${code}. Read the command output above and try again.`)),
    );
  });
}

async function npmCliPath() {
  const executableFolder = path.dirname(process.execPath);
  const candidates = [
    path.join(executableFolder, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableFolder, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  try {
    candidates.push(createRequire(import.meta.url).resolve('npm/bin/npm-cli.js'));
  } catch { /* Portable paths or PATH are checked next. */ }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch { /* Try next candidate. */ }
  }
  return null;
}

async function runNpm(argv, env = process.env) {
  const npmCli = await npmCliPath();
  if (npmCli) {
    return run(
      process.execPath,
      ['--use-env-proxy', '--use-system-ca', npmCli, ...argv],
      { env },
    );
  }
  if (process.platform !== 'win32') return run('npm', argv, { env });
  throw new Error(
    'The portable Node runtime is missing npm. Delete .vanta-runtime\\node-v24.22.0-win-x64 and launch START-VANTA.cmd again.',
  );
}

async function installDependencies({ includeDev }) {
  const lock = await readFile(path.join(root, 'package-lock.json'));
  const fingerprint = createHash('sha256').update(lock).digest('hex');
  const marker = path.join(
    runtime,
    includeDev ? 'dependencies-dev.sha256' : 'dependencies-prod.sha256',
  );
  try {
    if ((await readFile(marker, 'utf8')) === fingerprint) {
      await access(path.join(root, 'node_modules', 'express', 'package.json'));
      if (includeDev) await access(path.join(root, 'node_modules', 'vite', 'package.json'));
      return;
    }
  } catch { /* A clean install is needed. */ }

  console.log(
    includeDev
      ? 'Installing the free build dependencies from the locked package list...'
      : 'Installing the free app dependencies from the locked package list...',
  );
  const env = { ...process.env };
  delete env.XAI_API_KEY;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
  const npmArgs = [
    'ci',
    ...(includeDev ? [] : ['--omit=dev']),
    '--no-audit',
    '--no-fund',
    '--cache',
    path.join(runtime, 'npm-cache'),
  ];
  await runNpm(npmArgs, env);
  await writeFile(marker, fingerprint);
}

async function frontendExists() {
  try {
    await access(path.join(root, 'dist', 'index.html'));
    return true;
  } catch {
    return false;
  }
}

async function ensureFrontend() {
  if (await frontendExists()) {
    await installDependencies({ includeDev: false });
    return;
  }

  console.log('');
  console.log('VANTA frontend is not built yet. Building it automatically now...');
  console.log('This uses free local Node tools and does NOT use AI credits.');
  await installDependencies({ includeDev: true });

  const env = { ...process.env };
  delete env.XAI_API_KEY;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');

  // The local desktop server only needs Vite's normal dist/index.html.
  // Do NOT run the full npm build here: that also runs strict TypeScript
  // checking and standalone packaging, either of which can stop desktop
  // startup even when the browser app itself is perfectly buildable.
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  await access(viteBin);
  await run(process.execPath, ['--use-env-proxy', '--use-system-ca', viteBin, 'build'], { env });

  if (!(await frontendExists())) {
    throw new Error(
      'Vite finished without creating dist\\index.html. Delete web\\dist and launch START-VANTA.cmd again.',
    );
  }
  console.log('VANTA frontend build complete.');
}

async function stop() {
  if (stopping) return;
  stopping = true;
  server?.close();
  if (app) {
    await Promise.allSettled([
      app.locals.videoService.close(),
      app.locals.aiService.close(),
    ]);
  }
  server?.closeAllConnections();
  process.exit(0);
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 5)) {
    throw new Error('Node.js 24.5 or newer is required. Use the supplied desktop launcher.');
  }

  const portIndex = args.indexOf('--port');
  const port = portIndex < 0 ? 0 : Number(args[portIndex + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Choose a valid local port.');
  }

  await mkdir(runtime, { recursive: true });

  // Source ZIPs do not contain dist/. Build it before trying to serve the app.
  await ensureFrontend();

  const tools = await ensureTools(root);
  for (const tool of Object.values(tools)) {
    const result = spawnSync(tool, ['-version'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(
        'A video tool cannot run on this computer. Check START-HERE.txt for supported platforms.',
      );
    }
  }

  // Normal VANTA launches are local-only. Never require or consume xAI credits.
  delete process.env.XAI_API_KEY;

  const { createApp } = await import('../server/index.js');
  app = await createApp({ ...tools, dataDir: path.join(root, '.data') });

  server = await new Promise((resolve, reject) => {
    const listener = createServer((req, res) => {
      const host = `127.0.0.1:${listener.address().port}`;
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Open VANTA from its local launcher to use this server.',
        }));
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
  console.log(`\nVANTA is running locally: ${url}`);
  console.log('No xAI key or generation credits are used by this launcher.');
  console.log('Keep this terminal open. Press Ctrl+C here to stop.');

  if (!args.includes('--no-open')) {
    const opener =
      process.platform === 'win32'
        ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
            detached: true,
            stdio: 'ignore',
          })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
            detached: true,
            stdio: 'ignore',
          });
    opener.on('error', () =>
      console.log('Open the address above in your browser.'),
    );
    opener.unref();
  }
} catch (error) {
  console.error(`\nVANTA could not start: ${error.message}`);
  if (app) {
    await Promise.allSettled([
      app.locals.videoService.close(),
      app.locals.aiService.close(),
    ]);
  }
  server?.close();
  process.exitCode = 1;
}
