#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
bash scripts/bootstrap-local.sh "$@"
vanta_status=$?
if [ "$vanta_status" -ne 0 ] && [ -t 0 ]; then
  printf '\nStartup stopped. Read the message above. Press Enter to close. '
  read -r
fi
exit "$vanta_status"
