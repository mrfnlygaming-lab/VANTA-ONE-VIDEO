# VANTA ONE VIDEO

## Browser image-to-video studio

[VANTA Motion Studio](web/README.md) has **AI scene** and **Camera sequence** modes.
AI scene sends one to three references together with the full scene prompt to
Grok for subject animation. It needs a server-side `XAI_API_KEY` and xAI credits.
Reference scenes use a native 720p source, exported as a labeled 1080p upscale.
The integration is tested with mocks; live paid generation is not yet verified.

Camera sequence exports up to six ordered photos with pan/zoom at 1080p and an
extension popup. It needs no API key. [Download the offline camera app](downloads/README.md),
extract the ZIP, open VANTA-OPEN.html in Chrome/Edge, and select **Camera sequence**.
The offline download cannot generate AI subject movement.

For the server version (Node.js24 and FFmpeg required):

```sh
cd web
npm ci --cache /tmp/vanta-npm-cache
npm run build
npm start
```

Configure the key securely in Environment settings for AI mode. The server uses
port3001; this onboarding screen cannot expose a live preview. See the web README
for setup, provider sources, privacy, storage, and validation.

## Original on-device iPhone text-to-video integration (research build)

**Status: Source integration written, not a tested app.** This package contains real SwiftUI interface code wired to the **MOVD (Mobile-Oriented Video Diffusion)** inference implementation. It does NOT include the several-gigabyte Core ML model weights, a compiled IPA, or a seven-second video-generation breakthrough. It cannot generate video without an actual MOVD model asset bundle.

The MOVD research project is here: https://github.com/eai-lab/MOVD (MIT license). Its public model files are here: https://drive.google.com/drive/folders/1L6pVi3KmyLygR_pvKofRL-21adKsEb4p . The researchers demonstrate **text-to-video** on an **iPhone 15 Pro**, not a verified iPhone 16 installation. They report mobile rendering times measured in minutes, and the original interface generates a few seconds of silent 192x192/256x256 footage. **MOVD does not supply reference-photo-to-video, 60-second video, synchronized sound, prompt-perfect editing, or Grok-quality output.**

## What's in this build

- Original VANTA ONE local chat, voice, reading, and Image Playground source.
- Added video studio with prompt field, 192 / 256 output, LPL and temporal token merging controls, inference status, video player, unique MP4 saves in Documents, and video sharing.
- `VIDEO_ENGINE/VideoStudioView.swift` directly calls MOVD `SoraPipeline`, which runs a real T5 text encoder, STDiT video diffusion, VAE video decoder, and MP4 export locally on iPhone. No internet-generation APIs.
- `scripts/assemble_video_app.py` combines official open-source MOVD Swift engine with VANTA UI and verifies that the required weights exist before attempting a build.
- `.github/workflows/build-video-iphone.yml` is an experimental no-Mac GitHub Actions path: it fetches MOVD source and public weights, assembles, compiles, and exports an **unsigned IPA if successful**. It can fail due to public Google Drive download restrictions, multi-gigabyte weights, GitHub runner disk quota, upstream build issues, or SDK incompatibility. No installation was verified.

## What you need to finish installing on iPhone 16

**Mac + Xcode (most dependable way):**

1. Clone or download the official MOVD repo from https://github.com/eai-lab/MOVD .
2. Download its converted Core ML weights from the researchers' Google Drive link. Keep the `.mlpackage` directories intact, as Xcode must compile the VAE typed-model classes. These files can be very large. The `tokenizer.json` and `tokenizer_config.json` files are also required.
3. Extract this VANTA kit and run:
   `python3 scripts/assemble_video_app.py --movd /path/to/MOVD --models /path/to/models --output /path/to/VANTA_VIDEO_BUILT`
4. Open `VANTA_VIDEO_BUILT/On-Device-MOVD-Sora.xcodeproj` in Xcode 26+, configure your Apple Personal Team, and run on your own iPhone 16. Test memory usage and runtime on the physical device.

**Windows without a Mac (experimental):**

1. Extract this ZIP. Create a free **public GitHub repository** from the folder. Upload every file including the hidden `.github/workflows/build-video-iphone.yml`.
2. The workflow automatically starts when all files are pushed to the `main` branch; you can also use GitHub Actions → **Build VANTA ONE with real on-device AI video** → **Run workflow**.
3. If the downloaded weights fit and the build succeeds, download the artifact `VANTA_ONE_VIDEO_unsigned_IPA` and sideload via Sideloadly with your free Apple Account.
4. If the build fails while downloading weights, the source is still usable on a Mac. GitHub Actions is not a guaranteed free service for distributing giant apps. A free Apple Personal Team installation also must be signed again after 7 days.

This app runs locally **after installation**; it needs no home PC or network connection for inference, and has no in-app purchases, advertising, API charges, or paid cloud generation service. Apple's personal-install signing renewal and the initial model download are not optional.

## Notes and honest limitations

- This is **text-to-video**: generating a moving scene from words. A photo-to-video button would be dishonest without another model and actual image-conditioning code.
- The generated clips are silent; a local video editor can add a recorded audio track, but this is not Grok-like AI audio generation.
- The generated videos are short and low-resolution; the original MOVD model is large and slow.
- A model-file check blocks video generation when required model assets are absent. The assembly script blocks builds when weights are incomplete.
- Video generation is not fully tested. Swift syntax parsing was performed; full iOS Core ML/Xcode build could not be run in this environment. Be prepared for upstream model and SDK compatibility work.
- Open source attribution: `eai-lab/MOVD` licensed MIT. The app assembles upstream MOVD through GitHub; third-party model licensing must be reviewed separately.
