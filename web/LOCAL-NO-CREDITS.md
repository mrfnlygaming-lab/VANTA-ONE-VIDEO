# VANTA Motion Studio — no-credit local image-to-video

The Codex branch now defaults to a local LTX-Video GPU backend, not Grok,
xAI, a paid trial, or any credit-limited video API. Uploaded photos and prompts
are processed locally by the PC server; the AI model generates actual new frames.
There is NO per-generation payment, xAI API key, or cloud generation account.

## Run on Windows using existing LTX

> **Important:** use a freshly downloaded copy of this branch. Old extracted folders can still contain the pre-fix `scripts/start-local.mjs` that crashes on a missing `dist/index.html`. The current `START-VANTA.cmd` downloads portable Node if needed, builds the UI automatically, and starts the local LTX backend.

1. Download this branch source ZIP:
   https://github.com/mrfnlygaming-lab/VANTA-ONE-VIDEO/archive/refs/heads/codex/vanta-browser-studio.zip
2. Extract the ZIP and go into the web folder.
3. Double-click START-VANTA.cmd.
4. Open http://127.0.0.1:3001 if the browser does not open automatically.

The launcher defaults to your existing LTX repo at:
    P:\GROK\AXG-Motion\LTX-Video
and your existing Python at:
    P:\GROK\python.exe

If those locations differ, edit the two LTX_DIR / LTX_PYTHON lines near the
top of START-VANTA.cmd. It also needs free Node.js 24, npm, FFmpeg and
FFprobe installed. Set FFMPEG_PATH and FFPROBE_PATH to the full paths of those
executables if they are not on PATH. The launcher does not redownload giant
model weights or touch paid cloud providers. The existing Python environment
must already contain working LTX dependencies and model weights.

The server binds to 127.0.0.1 only. Keep the CMD window open during rendering.

## First generation

1. Select AI scene - local GPU.
2. Add ONE starting JPG, PNG or WebP image.
3. Type a real motion prompt, for example: "A dog raises its head and wags
   its tail, natural daylight, stable camera."
4. Choose 3 seconds, then Generate AI scene.
5. After local GPU inference, download the resulting H.264 MP4.

This calls the official local image-conditioning LTX inference.py entry point
with conditioning_media_paths pointing at your photo and frame 0.
It automatically looks for 2B distilled model configs from 0.9.8 and 0.9.6
or 2B 0.9.6 dev. If your existing model uses a different config file, set
LTX_CONFIG to the full YAML path before starting the app.

The image is resized to 512x288, 288x512, or 384x384 depending on aspect
ratio. The generated output is labeled as an upscaled 1080p export, NOT
native 1080p detail. GPU model rendering can take minutes or longer. It is
not a seven-second miracle. Try 3 seconds first, especially with 16 GB VRAM.

## Limitations and credit policy

- Local AI uses ONE starting image per scene. It does not combine three
  different subject photos into one new scene as Grok may do.
- Camera sequence can take 2-6 ordered photos but only creates pan/zoom
  motion, not invented subject movement.
- Local AI produces silent footage; no voice or synced audio generation.
- Photo identity may drift. GPU memory can run out, especially for 10 seconds.
- Cancel stops the local Python inference process and removes temporary data.
- Completed MP4s are saved under web/.data/ai-videos and the latest 50
  completed video records are retained.
- Real AI inference needs working model weights, local compute, and storage.
  This cannot be eliminated by swapping out a paid API.
- The source and backend are committed, but live Windows model generation has
  not yet been verified on your PC.

The older VANTA-AI-LOCAL-SERVER.zip was built before the no-credit patch
and STILL USES xAI credits. Do not use that obsolete archive. The updated
source ZIP above is the no-credit branch.

## Test commands

From the web folder:
    npm ci
    npm run build
    npm test

Tests do not replace a real 3-second GPU smoke test on the Windows computer.
Existing xAI code is retained for legacy mock-provider tests only; the
default server instance always selects the local LTX backend instead.
