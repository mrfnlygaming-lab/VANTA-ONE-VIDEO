# VANTA Motion Studio (no-credit local GPU edition)

The default AI engine runs LTX-Video locally on your Windows PC.
It does NOT use xAI credits, paid Grok generation, or an API key.

Start here: [Windows instructions and current download](LOCAL-NO-CREDITS.md).
Run the web/START-VANTA-LOCAL.cmd Windows launcher from this branch source.

## Two real generation modes

**AI scene - local GPU** uses ONE starting photo and your prompt to generate
new moving frames using a preinstalled local LTX-Video Python model. It
exports an upscaled 1080p H.264 MP4. Image identity and motion are not
guaranteed. Choose 3 seconds for a first smoke test. Rendering can take
minutes or longer depending on GPU model, installed weights, and settings.

**Camera sequence** takes 1-6 ordered images, applies camera pan/zoom via
FFmpeg, and exports up to 1080p without generating new subject movement.
It supports repeated short extensions and needs no model download.

The standalone HTML and older camera-only ZIP remain camera-only.
The old VANTA-AI-LOCAL-SERVER.zip is OBSOLETE: it still asks for xAI
credits. Download this updated Codex branch instead.

## Requirements

Windows 11 with a working CUDA/LTX-Video installation, local 2B LTX
checkpoint and config, FFmpeg, FFprobe, Node.js 24 and npm.
Default model path is P:\GROK\AXG-Motion\LTX-Video and Python is
P:\GROK\python.exe. Configure LTX_DIR, LTX_PYTHON, LTX_CONFIG,
FFMPEG_PATH and FFPROBE_PATH if your tools are located elsewhere.
The app listens only on http://127.0.0.1:3001.

See LOCAL-NO-CREDITS.md for simple steps, limitations and troubleshooting.

## Local API

- GET /api/health — running status
- GET /api/capabilities — true AI mode availability based on installed local files
- POST /api/videos engine=ai — one photo, prompt, duration and format
- POST /api/videos engine=camera — ordered photos and camera settings
- GET /api/videos/:id — queue/render status
- GET /api/videos/:id/file — download MP4 after successful render
- DELETE /api/videos/:id — stop current local render and remove its artifacts

## Developer checks

From the web directory run npm ci, npm run build, and npm test.
The local AI worker runs an official LTX CLI command instead of a paid
provider API. The legacy XaiService code is used only when a test injects
mock provider options; it is not selected for normal user launches.

This code has not yet been verified against your own Windows GPU and local
model files, so do not mistake a committed backend for a proven completed
render. There is no automatic posting, public hosting, or iPhone-native
install from this browser project.
