#!/usr/bin/env python3
"""Package the already-built standalone app using Python's standard library."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
html = root / "dist" / "VANTA-OPEN.html"
if not html.is_file():
    raise SystemExit("Build first with npm run build:standalone")
target = root / "dist" / "VANTA-MOTION-STUDIO.zip"
with ZipFile(target, "w", compression=ZIP_DEFLATED) as archive:
    archive.write(html, "VANTA-OPEN.html")
    archive.write(root / "OPEN-ME.txt", "OPEN-ME.txt")
with ZipFile(target) as archive:
    if archive.testzip() is not None:
        raise SystemExit("ZIP validation failed")
print(f"Downloadable app: {target} ({target.stat().st_size:,} bytes)")
