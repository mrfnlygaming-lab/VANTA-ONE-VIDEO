# VANTA Motion Studio

A browser-based image-to-video studio. Upload a photo, select camera motion,
duration, and aspect ratio, then preview and download an actual H.264 MP4.

## Open without a server

Build the project with `npm run build`, then open **dist/VANTA-OPEN.html**
directly in a current Chrome or Edge browser. This standalone app contains its
styles, interface, example image, and video renderer in one file. It works
without Node.js, FFmpeg, a web server, network access, or the environment's preview
panel on the computer where you open it. Node/npm are needed only to build it.

Choose **Try an example**, pick a duration, and select **Generate video**.
Keep the tab visible while it records, then select **Download**. The browser
prefers MP4/H.264 recording and uses WebM where MP4 recording is unavailable.
The actual format appears in the app and its download extension.
Recording happens in real time, targeting 24 fps; actual frame timing depends on
browser performance. The app stops with an actionable message if the tab is hidden.

The standalone app's **My videos** uses browser storage. Storage may be disabled
in private browsing or limited for local files; the app shows a warning and keeps
the current result downloadable when persistence fails. Download any videos you
want to keep before clearing browser data. This browser library is separate from
the server-backed app's library below.

To rebuild only the standalone file, use `npm run build:standalone` after
dependencies have been installed. This does not require starting a service.
For a downloadable ZIP with opening instructions, run
`python3 scripts/package-standalone.py` after building (Python 3 is needed for
packaging only). Extract `dist/VANTA-MOTION-STUDIO.zip` and open the HTML file.

This version creates **pan-and-zoom camera animation**. It does not generate new
subject movement with an AI model. No API key, paid credits, or model downloads
are required. The original iPhone app and MOVD research integration remain in
the repository as separate projects.

## Run the server-backed version

Requirements: Node.js 22 or newer, npm, and FFmpeg/ffprobe with the `libx264`
encoder on the server. The cloud environment already supplies these tools.
On Debian/Ubuntu, FFmpeg can be installed with `apt-get install ffmpeg`.

From this directory (`/workspace/VANTA-ONE-VIDEO/web` in the cloud environment):

```sh
npm ci --cache /tmp/vanta-npm-cache
npm run build
npm start
```

The server listens on port **3001** on all interfaces and serves both the built
client and API. `PORT` can override the port. For development, `npm run dev`
runs Vite on port **5173** and the API on **3001**, with API requests proxied
by Vite. Keep both processes running while developing.

## Use

1. Upload a JPG, PNG, or WebP image, or choose **Try an example**.
2. Choose Push in, Pull out, Pan left, Pan right, or Still.
3. Select 3, 5, or 10 seconds and landscape, portrait, or square format.
4. Select **Generate video**, then play or download the result.
5. **My videos** lists saved exports and allows downloading or deleting them.

Landscape exports at 1280 × 720, portrait at 720 × 1280, and square at 720 × 720.
Videos are silent at 24 fps. Images fill the selected aspect ratio using a
center crop; camera movement crops slightly farther into the image. Transparent
pixels are composited over black. The instant motion preview is an approximation;
the exported MP4 is the final result.

## Storage and operation

Original uploads are removed after rendering or cancellation. Completed MP4s and
their metadata are saved in ignored `.data/videos/`, restored at server startup,
and limited to the **50 most recent videos**. Older exports are automatically
removed. Deleting a video removes its server files. Download exports you want to
keep before removing this directory or the app.

This is a personal workspace app: it has no user accounts or per-user isolation.
Anyone with access to its server can see or remove its saved videos. Add
authentication before sharing it as a public multi-user service.

The backend accepts at most 20 MB per upload and 40 megapixels per image, with a
maximum of 16,384 pixels per side. A single rendering worker and a bounded queue
limit CPU and memory use. Camera presets and paths are controlled by the server.
FFprobe validates image signatures and video output; the renderer uses restricted
local-file protocols and bounded subprocesses. No external generation API is used.

## Validate

```sh
npm test
npm run build
```

The integration suite runs real FFmpeg exports and verifies image validation,
visible motion, H.264 encoding, resolution, frame rate, duration, byte-range
downloads, persistence, deletion, queue limits, cancellation, and transparent and
extreme-aspect-ratio images. It needs FFmpeg/ffprobe and writes temporary files
outside the checkout.

For a functional browser check, generate an example video, play it, download it,
reload My videos, then delete it. A successful health response from
`GET /api/health` alone does not verify rendering.

The GitHub Actions **Validate browser video studio** workflow installs frozen
dependencies, runs the real integration tests, and builds the client on Linux.

## API

| Request | Purpose |
| --- | --- |
| `GET /api/health` | Server status |
| `POST /api/videos` | Multipart `image`, `motion`, `duration`, `format`; returns a job |
| `GET /api/videos/:id` | Poll job status and render progress |
| `GET /api/videos` | List completed videos |
| `GET /api/videos/:id/file` | Stream/download MP4, including byte ranges |
| `DELETE /api/videos/:id` | Cancel rendering or remove a saved video |
