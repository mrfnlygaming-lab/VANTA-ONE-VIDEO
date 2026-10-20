# VANTA Motion Studio

A browser image-to-video studio with two generation modes:

- **AI scene:** send one to three reference images together and the entire scene
  prompt to Grok, generating subject movement in one scene. Requires the server
  version, an xAI API key, and xAI credits.
- **Camera sequence:** animate one to six photos in playback order using pan and
  zoom, with no API key. Exports at 1080p and supports appended extensions.

## AI scenes with Grok

Run the server version below. Set `XAI_API_KEY` securely in your environment's
secret settings, allow HTTPS to `api.x.ai` and `vidgen.x.ai`, then restart the
server. Never put the key in frontend code, the downloaded HTML, or chat. The
cloud configuration draft includes this secret requirement and these domains;
saving a draft does not apply runtime settings or publish an environment.

1. Choose **AI scene · all references together**.
2. Add one to three JPG, PNG, or WebP reference images. Two images describe a
   single scene; they are not played as successive stills.
3. Describe the complete action, interaction, setting, lighting, and camera
   movement. Use `<IMAGE_0>`, `<IMAGE_1>`, and `<IMAGE_2>` to identify references.
   For example: “The person in <IMAGE_0> walks toward the dog in <IMAGE_1>,
   kneels, and gently pets it. One continuous shot in warm afternoon light.”
4. Choose 3, 5, or 10 seconds and an aspect ratio, then **Generate AI scene**.
5. Wait for the provider and download the resulting H.264 MP4.

The app sends the full prompt unchanged, including line breaks, with all images
in one `reference_images` request to `grok-imagine-video-1.5`. Prompt adherence
and the resulting motion depend on the model and are not guaranteed. There is
no camera-animation fallback if the provider fails. AI scene extension is not
implemented; the extension popup is available for Camera sequence videos.

**Resolution:** xAI reference-to-video supports a native 720p source. The server
upscales that video to 1920 × 1080 landscape, 1080 × 1920 portrait, or 1080 × 1080
square. The interface marks it **1080p (upscaled)**. This does not create native
1080p model detail. Provider audio, if present, is retained.

AI generation sends your images and prompt to xAI and consumes your xAI credits.
Stopping the local wait does not cancel the provider's job or its charges. The
API key stays on the server; it is sent only to the official API, never to the
video CDN. See [AI-RESEARCH.md](AI-RESEARCH.md) for verified official sources.

The integration is tested with a mocked provider and actual FFmpeg conversions.
A live paid generation has not been verified in this environment because
`XAI_API_KEY` is not configured.

## Run the server version

Requirements: **Node.js 24**, npm, and FFmpeg/ffprobe with `libx264`. The cloud
machine supplies them. On Debian/Ubuntu, install FFmpeg with `apt-get install ffmpeg`.

From this directory (`/workspace/VANTA-ONE-VIDEO/web`):

```sh
npm ci --cache /tmp/vanta-npm-cache
npm run build
npm start
```

The server binds all interfaces on port **3001**, serving the client and API.
`PORT` overrides the port. `npm start` enables Node's environment proxy and system
CA support for the cloud's HTTPS proxy and secret bindings. `npm run dev` starts
Vite on **5173** and the API on **3001**. Live processes need restarting in a new
task. This onboarding screen does not expose a live web preview; publishing the
environment does not publish a website.

The original Swift iPhone/MOVD research project is separate and is not required
for this browser workflow.

## Open the camera app without a server

Download the ZIP in [downloads](../downloads/README.md), extract it, and open
**VANTA-OPEN.html** in a current Chrome or Edge browser. To rebuild, run
`npm run build` followed by `python3 scripts/package-standalone.py`.

**Select Camera sequence** in the generation mode selector. The offline HTML
cannot call Grok or create AI subject movement; its AI mode explains that the
server and key are required. The camera renderer, styles, and example image are
all embedded, so camera mode needs no server, account, key, or internet access.

1. Add one to six images or choose **Try an example**. Reorder the thumbnails.
2. Enter an optional camera prompt, such as “pan left” or “zoom out.” Recognized
   camera words select the move; other details are saved as notes. The first
   recognized move wins if several are present.
3. Choose 3, 5, or 10 seconds total and landscape, portrait, or square format.
4. Select **Generate video** and keep the tab visible while it records.
5. The completion popup offers **Generate extension**, **Not now**, and download.
   Extensions append 3, 5, or 10 seconds using new images or the parent's final
   frame. The original remains available. Repeat up to 60 seconds total.

Camera output is silent, targets 24 fps, and uses 1920 × 1080 landscape,
1080 × 1920 portrait, or 1080 × 1080 square. Images share the duration evenly,
fill the frame with a center crop, and use black behind transparent pixels.
Extensions of older 720p videos keep the parent's dimensions.

The browser prefers MP4/H.264 and uses WebM if unavailable. Recording timing
varies with device performance. Browser storage can be disabled or cleared;
download results you want to keep. The server and browser libraries are separate.
Some managed browsers block local HTML by policy; leave their policies unchanged.

## Storage and operation

Server camera exports live in ignored `.data/videos/`; AI exports in
`.data/ai-videos/`. Each service retains its latest 50 completed videos and restores
them at startup. Uploaded reference files are removed after processing or local
cancellation. Deleting an AI job cannot undo a request already sent to xAI.
Download videos before deleting the data directory or clearing browser storage.

This is a personal workspace without authentication or per-user isolation.
Anyone with server access can use configured xAI credits and see or delete
videos. Add authentication before deploying a public service.

Camera uploads allow six images, 20 MB each and 60 MB combined, with a maximum
of 40 megapixels and 16,384 pixels per side. AI accepts at most three references.
Both services validate actual media bytes and bound their queues. The AI worker
submits one provider job at a time, checks moderation, restricts downloads to the
provider CDN, and verifies encoded output before exposing a completed video.

## Validate

```sh
npm test
npm run build
python3 scripts/test-standalone.py
python3 scripts/test-storyboard.py
python3 scripts/test-ai-scene-ui.py
```

The 28 Node tests exercise real FFmpeg camera exports, validation, visible motion,
1080p dimensions, extension continuity, downloads, persistence, cleanup, queues,
and a mocked xAI provider with real 720p-to-1080p conversion. AI tests verify two
and three references in one request, full prompt preservation, empty HTTP 202
polling, moderation, unsafe URLs, failures, and timeouts. They make no paid calls.

The browser scripts need Python Playwright, Chromium, and FFmpeg. They use the
production build. Standalone tests serve its exact HTML through an offline
route; managed Chromium prevents direct file navigation. The AI UI test mocks
the API and does not establish live model quality or prompt adherence.

The GitHub Actions **Validate browser video studio** workflow installs frozen
dependencies, runs Node integration tests, and builds the client on Linux.

## API

| Request | Purpose |
| --- | --- |
| `GET /api/health` | Local service health |
| `GET /api/capabilities` | Whether the xAI key is configured and supported modes |
| `POST /api/videos` | Multipart `engine=ai`, repeated `image` (1–3), full `prompt`, `duration`, `format` |
| `POST /api/videos` | Multipart `engine=camera` (default), repeated `image` (1–6), optional camera `prompt`, `motion`, `duration`, `format` |
| `POST /api/videos` with `parentId` | Append a camera scene; new images optional, format inherited |
| `GET /api/videos/:id` | Poll a job |
| `GET /api/videos` | List completed videos |
| `GET /api/videos/:id/file` | Stream/download MP4 with byte ranges |
| `DELETE /api/videos/:id` | Stop local work or remove saved video; cannot cancel remote xAI generation |
