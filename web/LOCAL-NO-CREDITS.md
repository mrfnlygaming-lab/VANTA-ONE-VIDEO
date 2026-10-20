# VANTA Motion Studio — local VANTA Motion Core

VANTA now uses **VANTA Motion Core** as its only AI video engine in this branch.
There is no xAI/Grok API key, no paid generation credit requirement, and no alternate video-model fallback.

## What VANTA Motion Core is today

The current core runs the local Wan 2.1 T2V 1.3B stack already used for the XZAKUT training work, plus the trained VANTA motion adapter:

- Python: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\venv\\Scripts\\python.exe`
- Generator: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\musubi-tuner\\src\\musubi_tuner\\wan_generate_video.py`
- Base DiT: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\models\\split_files\\diffusion_models\\wan2.1_t2v_1.3B_bf16.safetensors`
- VAE: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\models\\split_files\\vae\\wan_2.1_vae.safetensors`
- T5: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\models\\models_t5_umt5-xxl-enc-bf16.pth`
- Trained adapter: `P:\\GROK\\XZAKUT_TRAINING_NATIVE\\trained_loras_original_v6\\XZAKUT_FIRST_TEST.safetensors`

The app calls the same Wan/Musubi generation path that successfully loaded the trained LoRA in the comparison run.

## Reference images

Reference images are deliberately disabled in VANTA Motion Core for now.

The confirmed local checkpoint is T2V, not an image-conditioned 1.3B checkpoint. VANTA will not silently route images through another video model just to make the button appear complete.

**VANTA Reference Core** is the next custom adapter: it will be trained on top of the same VANTA motion backbone so 1–4 reference images, selected background, identity and outfit guidance can return without an unrelated fallback model.

## Audio

VANTA includes an optional post-render **Auto Sound** stage.

The planned primary local audio engine is HunyuanVideo-Foley XL. It runs after video generation so the video model can release VRAM first. If the audio model is not installed, VANTA keeps the completed silent video instead of failing the whole job.

Dialogue will be a separate local layer, then VANTA will mix dialogue + Foley/ambience and mux the result into the MP4.

## Start VANTA

1. Download the current Codex branch.
2. Extract it.
3. Open the `web` folder.
4. Run `START-VANTA.cmd`.

The launcher uses portable Node when needed, builds the frontend, starts the local server, and opens the browser.

## Current truth

- AI generation: VANTA Motion Core only.
- Base architecture: Wan 2.1 T2V 1.3B.
- Custom weights: XZAKUT trained motion LoRA.
- References: temporarily disabled until VANTA Reference Core is trained.
- Sound: optional local post-render pipeline; requires its own installed model.
- Credits: no paid video-generation API credits.
- Output: locally upscaled 1080p MP4.
- Camera sequence mode: still available as a non-AI pan/zoom tool.
