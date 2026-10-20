@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title VANTA Motion Core - local GPU
echo.
echo ==============================================
echo VANTA MOTION CORE - LOCAL / NO API CREDITS
echo ==============================================
echo.
echo AI core:
echo   P:\GROK\XZAKUT_TRAINING_NATIVE
echo.
echo Starting the main portable launcher...
echo.
call START-VANTA.cmd
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo VANTA stopped with exit code %RC%.
  pause
)
exit /b %RC%
