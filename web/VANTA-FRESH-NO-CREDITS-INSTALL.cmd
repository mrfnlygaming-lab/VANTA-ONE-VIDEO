@echo off
setlocal EnableExtensions
title VANTA Fresh No-Credits Install

set "TARGET=P:\GROK\VANTA-ONE-VIDEO-NO-CREDITS-FRESH"
set "ZIP=%TEMP%\VANTA-ONE-VIDEO-codex-vanta-browser-studio.zip"
set "URL=https://github.com/mrfnlygaming-lab/VANTA-ONE-VIDEO/archive/refs/heads/codex/vanta-browser-studio.zip"

echo.
echo ===============================================================
echo   VANTA FRESH INSTALL - CURRENT CODEX BRANCH - NO AI CREDITS
echo ===============================================================
echo.
echo This does NOT touch your old broken VANTA folder.
echo New copy:
echo   %TARGET%
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$target='%TARGET%'; $zip='%ZIP%'; $url='%URL%';" ^
  "if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force };" ^
  "if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force };" ^
  "New-Item -ItemType Directory -Force -Path $target | Out-Null;" ^
  "Write-Host 'Downloading the CURRENT Codex branch...';" ^
  "Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip;" ^
  "Write-Host 'Extracting fresh VANTA...';" ^
  "Expand-Archive -LiteralPath $zip -DestinationPath $target -Force;" ^
  "$repo = Get-ChildItem -LiteralPath $target -Directory | Select-Object -First 1;" ^
  "if (-not $repo) { throw 'The GitHub ZIP extracted without a repo folder.' };" ^
  "$web = Join-Path $repo.FullName 'web';" ^
  "$start = Join-Path $web 'START-VANTA.cmd';" ^
  "$local = Join-Path $web 'scripts\start-local.mjs';" ^
  "if (-not (Test-Path -LiteralPath $start)) { throw 'Fresh START-VANTA.cmd is missing.' };" ^
  "if (-not (Test-Path -LiteralPath $local)) { throw 'Fresh scripts\start-local.mjs is missing.' };" ^
  "$text = Get-Content -LiteralPath $local -Raw;" ^
  "if ($text -notmatch 'Source ZIPs do not contain dist') { throw 'GitHub returned an old cached startup script. Run this installer again in a minute.' };" ^
  "Set-Content -LiteralPath (Join-Path $target 'FRESH_WEB_PATH.txt') -Value $web;" ^
  "Write-Host '';" ^
  "Write-Host 'Fresh fixed copy verified.' -ForegroundColor Green;" ^
  "Write-Host ('Web folder: ' + $web);" ^
  "Write-Host '';" ^
  "Write-Host 'Launching VANTA now...';" ^
  "& cmd.exe /d /c ('call ""' + $start + '""');" ^
  "exit $LASTEXITCODE"

set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" (
  echo ===============================================================
  echo VANTA fresh install/start returned exit code %CODE%.
  echo.
  echo The OLD folder was not touched.
  echo Copy the FIRST error shown above if it still stops.
  echo ===============================================================
)
pause
exit /b %CODE%
