@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title VANTA Motion Studio - no credits, local GPU
if not defined LTX_DIR set "LTX_DIR=P:\grok\AXG-Motion\LTX-Video"
if not defined LTX_PYTHON set "LTX_PYTHON=P:\grok\AXG-Motion\env\Scripts\python.exe"
echo.
echo ==============================================
echo VANTA LOCAL AI - NO CREDITS OR API KEY
echo ==============================================
echo LTX project: %LTX_DIR%
echo Python:      %LTX_PYTHON%
echo.
if not exist "%LTX_DIR%\inference.py" (
 echo ERROR: inference.py not found. Edit LTX_DIR at the top of this CMD file.
 goto :failed
)
if not exist "%LTX_PYTHON%" (
 echo ERROR: Python executable not found. Edit LTX_PYTHON at the top of this CMD file.
 goto :failed
)
where node >nul 2>nul || (echo ERROR: Install the free Node.js 24 runtime. & goto :failed)
where npm >nul 2>nul || (echo ERROR: npm was not found. & goto :failed)
if defined FFMPEG_PATH (
 if not exist "%FFMPEG_PATH%" (echo ERROR: FFMPEG_PATH does not exist. & goto :failed)
) else (
 where ffmpeg >nul 2>nul || (echo ERROR: FFmpeg not found. Set FFMPEG_PATH to ffmpeg.exe. & goto :failed)
)
if defined FFPROBE_PATH (
 if not exist "%FFPROBE_PATH%" (echo ERROR: FFPROBE_PATH does not exist. & goto :failed)
) else (
 where ffprobe >nul 2>nul || (echo ERROR: FFprobe not found. Set FFPROBE_PATH to ffprobe.exe. & goto :failed)
)
if not exist "node_modules\express\package.json" (
 echo Installing free app dependencies from lockfile...
 call npm ci
 if errorlevel 1 goto :failed
)
echo Building latest no-credit interface...
call npm run build
if errorlevel 1 goto :failed
echo.
echo The app runs only on this PC: http://127.0.0.1:3001
echo AI renders run on your own GPU. Initial model loading is not instant.
echo Keep this window open. Ctrl+C stops the app.
start "" "http://127.0.0.1:3001"
node server/index.js
goto :end
:failed
echo.
echo Setup incomplete. Nothing was charged and no cloud AI was called.
pause
:end
endlocal
