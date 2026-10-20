#!/usr/bin/env python3
"""Build the local-server ZIP from an explicit allowlist; never include secrets/media."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
files = [root / name for name in [
    'package.json', 'package-lock.json', 'START-VANTA.cmd', 'START-VANTA.command',
    'start-vanta.sh', 'DESKTOP-START.txt', 'shared/prompt.js',
    'scripts/start-local.mjs', 'scripts/desktop-tools.mjs',
    'scripts/desktop-tools.json', 'scripts/bootstrap-local.sh',
    'scripts/bootstrap-local.ps1',
]]
files += sorted((root / 'server').glob('*.js'))
files += [root / 'dist' / name for name in ['index.html', 'favicon.svg', 'sample-scene.svg']]
files += sorted((root / 'dist' / 'assets').glob('*'))
if not (root / 'dist' / 'index.html').is_file():
    raise SystemExit('Run npm run build first')
for file in files:
    if not file.is_file():
        raise SystemExit(f'Missing app file: {file.relative_to(root)}')
target = root / 'dist' / 'VANTA-AI-LOCAL-SERVER.zip'
with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
    for file in files:
        relative = 'START-HERE.txt' if file.name == 'DESKTOP-START.txt' else file.relative_to(root).as_posix()
        archive.write(file, 'VANTA-AI/' + relative)
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert all('/.env' not in name and '/.data/' not in name and '/node_modules/' not in name for name in archive.namelist())
print(f'Local AI server app: {target} ({target.stat().st_size:,} bytes)')
