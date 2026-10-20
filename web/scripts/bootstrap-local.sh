#!/usr/bin/env bash
set -euo pipefail
vanta_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$vanta_root"
vanta_node=""
if [[ "${VANTA_FORCE_PORTABLE_NODE:-0}" != 1 ]] && command -v node >/dev/null 2>&1; then
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=5)?0:1)' >/dev/null 2>&1; then
    vanta_node="$(command -v node)"
  fi
fi
if [[ -z "$vanta_node" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) vanta_target=linux-x64; vanta_sha=28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c ;;
    Linux-aarch64|Linux-arm64) vanta_target=linux-arm64; vanta_sha=b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d ;;
    Darwin-x86_64) vanta_target=darwin-x64; vanta_sha=495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91 ;;
    Darwin-arm64) vanta_target=darwin-arm64; vanta_sha=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5 ;;
    *) echo 'VANTA needs 64-bit Windows, macOS, or Linux on x64/arm64.' >&2; exit 1 ;;
  esac
  vanta_name="node-v24.22.0-$vanta_target"
  vanta_cache="$vanta_root/.vanta-runtime/node-downloads"
  vanta_archive="$vanta_cache/$vanta_name.tar.gz"
  mkdir -p "$vanta_cache"
  vanta_hash() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
    else shasum -a 256 "$1" | awk '{print $1}'; fi
  }
  if [[ ! -f "$vanta_archive" ]] || [[ "$(vanta_hash "$vanta_archive")" != "$vanta_sha" ]]; then
    echo 'Downloading verified portable Node.js 24.22.0…'
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 30 --max-time 300 \
      "https://nodejs.org/dist/v24.22.0/$vanta_name.tar.gz" -o "$vanta_archive.partial"
    if [[ "$(vanta_hash "$vanta_archive.partial")" != "$vanta_sha" ]]; then
      rm -f "$vanta_archive.partial"
      echo 'Node.js checksum verification failed. Startup stopped.' >&2
      exit 1
    fi
    mv "$vanta_archive.partial" "$vanta_archive"
  fi
  rm -rf "$vanta_root/.vanta-runtime/$vanta_name"
  tar -xzf "$vanta_archive" -C "$vanta_root/.vanta-runtime"
  vanta_node="$vanta_root/.vanta-runtime/$vanta_name/bin/node"
  export PATH="$(dirname "$vanta_node"):$PATH"
fi
exec "$vanta_node" --use-env-proxy --use-system-ca "$vanta_root/scripts/start-local.mjs" "$@"
