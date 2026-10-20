// VANTA Motion Core.
// Current backbone: the local Wan 2.1 T2V 1.3B stack used for VANTA training,
// plus VANTA's trained XZAKUT motion adapter. No cloud video provider.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { XaiService } from "./xai-service.js";
import { RenderError } from "./renderer.js";
import { LocalAudioService } from "./local-audio-service.js";

const ROOT = "P:\\GROK\\XZAKUT_TRAINING_NATIVE";
const DEFAULTS = {
  python: path.join(ROOT, "venv", "Scripts", "python.exe"),
  script: path.join(ROOT, "musubi-tuner", "src", "musubi_tuner", "wan_generate_video.py"),
  dit: path.join(ROOT, "models", "split_files", "diffusion_models", "wan2.1_t2v_1.3B_bf16.safetensors"),
  vae: path.join(ROOT, "models", "split_files", "vae", "wan_2.1_vae.safetensors"),
  t5: path.join(ROOT, "models", "models_t5_umt5-xxl-enc-bf16.pth"),
  lora: path.join(ROOT, "trained_loras_original_v6", "XZAKUT_FIRST_TEST.safetensors"),
};

function execute(command, args, { cwd, signal, maxMs = 2_700_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RenderError("Generation cancelled.", 499));
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { timedOut = true; kill(); }, maxMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-48_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-48_000); });
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    child.once("error", error => finish(new RenderError(
      error.code === "ENOENT"
        ? "The VANTA Motion Core runtime could not be found."
        : "The VANTA Motion Core process could not start.",
      503,
    )));
    child.once("close", code => {
      if (signal?.aborted) return finish(new RenderError("Generation cancelled.", 499));
      if (timedOut) return finish(new RenderError("VANTA Motion Core exceeded 45 minutes.", 504));
      if (code !== 0) {
        const details = (stderr + "\n" + stdout).toLowerCase();
        const message = /out of memory|cuda.*memory|cuda error/.test(details)
          ? "GPU memory ran out in VANTA Motion Core. Close other GPU apps or use Turbo mode or a shorter clip."
          : /unused.*lora|lora.*unused/.test(details)
          ? "The VANTA motion adapter did not attach correctly. Restore the patched Musubi LoRA loader."
          : /no module named|modulenotfounderror/.test(details)
          ? "The VANTA motion training environment is missing a Python dependency."
          : "VANTA Motion Core generation failed. Check the Wan/Musubi terminal output.";
        return finish(new RenderError(message, 502));
      }
      finish();
    });
  });
}

async function probe(ffprobePath, file, signal) {
  const response = await execute(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height:format=duration",
    "-of", "json", file,
  ], { signal, maxMs: 30_000 });
  let parsed;
  try { parsed = JSON.parse(response.stdout); } catch {}
  const video = parsed?.streams?.[0];
  const duration = Number(parsed?.format?.duration);
  if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0)
    throw new RenderError("VANTA Motion Core did not return a valid video.", 502);
  return { ...video, duration };
}

const SPEED_PROFILES = {
  turbo: {
    steps: 6,
    fps: 8,
    landscape: { height: 320, width: 576 },
    portrait: { height: 576, width: 320 },
    square: { height: 320, width: 320 },
  },
  balanced: {
    steps: 8,
    fps: 12,
    landscape: { height: 384, width: 672 },
    portrait: { height: 672, width: 384 },
    square: { height: 384, width: 384 },
  },
  quality: {
    steps: 12,
    fps: 16,
    landscape: { height: 480, width: 832 },
    portrait: { height: 832, width: 480 },
    square: { height: 480, width: 480 },
  },
};

function renderProfile(format, speedMode = "turbo") {
  const profile = SPEED_PROFILES[speedMode] || SPEED_PROFILES.turbo;
  return {
    steps: profile.steps,
    fps: profile.fps,
    ...(profile[format] || profile.landscape),
  };
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function residentMp4s(root) {
  const files = [];
  try {
    for (const name of await readdir(root, { recursive: true })) {
      if (typeof name !== "string" || !name.toLowerCase().endsWith(".mp4")) continue;
      const file = path.join(root, name);
      try {
        const info = await stat(file);
        if (info.isFile()) files.push({ file, size: info.size, mtime: info.mtimeMs });
      } catch {}
    }
  } catch {}
  return files;
}

export class VantaMotionService extends XaiService {
  constructor(options) {
    super({ ...options, apiKey: "vanta-motion-local" });
    this.minReferenceImages = 0;
    this.maxReferenceImages = 0;
    this.root = path.resolve(process.env.VANTA_MOTION_ROOT || process.env.XZAKUT_WAN_ROOT || ROOT);
    this.python = process.env.VANTA_MOTION_PYTHON || process.env.XZAKUT_WAN_PYTHON || DEFAULTS.python;
    this.script = process.env.VANTA_MOTION_SCRIPT || process.env.XZAKUT_WAN_SCRIPT || DEFAULTS.script;
    this.dit = process.env.VANTA_MOTION_DIT || process.env.XZAKUT_WAN_DIT || DEFAULTS.dit;
    this.vae = process.env.VANTA_MOTION_VAE || process.env.XZAKUT_WAN_VAE || DEFAULTS.vae;
    this.t5 = process.env.VANTA_MOTION_T5 || process.env.XZAKUT_WAN_T5 || DEFAULTS.t5;
    this.lora = process.env.VANTA_MOTION_LORA || process.env.XZAKUT_WAN_LORA || DEFAULTS.lora;
    this.audioService = new LocalAudioService({ ffmpegPath: this.ffmpegPath });
    this.residentDir = path.join(this.videoDir, ".vanta-motion-resident");
    this.resident = null;
    this.residentLog = "";
    this.residentReady = false;
  }

  async init() {
    await super.init();
    await mkdir(this.residentDir, { recursive: true });
    for (const file of await residentMp4s(this.residentDir))
      await rm(file.file, { force: true }).catch(() => {});
    // Start loading the resident motion stack immediately while the browser opens.
    // The worker eagerly loads DiT/T5/VAE into memory; it does not create a dummy video.
    this.startResident();
  }

  stopResident() {
    const child = this.resident;
    this.resident = null;
    if (child && !child.killed) child.kill("SIGKILL");
  }

  startResident() {
    if (this.resident && !this.resident.killed) return this.resident;

    const bootstrap = [
      "import sys",
      "sys.modules['prompt_toolkit']=None",
      "script=sys.argv[1]",
      "args=sys.argv[2:]",
      "src=open(script,'r',encoding='utf-8').read()",
      "old=\"    text_encoder = None\\n    vae = None\\n    models = None\\n    clip = None\"",
      "new=\"    logger.info('VANTA resident: eager loading text encoder / VAE / DiT')\\n    text_encoder = load_text_encoder(args, cfg, device)\\n    text_encoder.model.to('cpu')\\n    vae = load_vae(args, cfg, device, vae_dtype)\\n    vae.to_device('cpu')\\n    models = load_dit_models(args, cfg, device, dit_dtype, dit_weight_dtype, is_i2v)\\n    clip = None\"",
      "src=src.replace(old,new)",
      "old2=\"                # Move model to CPU after generation\\n                for model in models:\\n                    if model is not None:  # not lazy loading\\n                        model.to('cpu')\"",
      "new2=\"                # VANTA resident mode: keep DiT on GPU between generations\\n                pass\"",
      "src=src.replace(old2,new2)",
      "sys.argv=[script]+args",
      "ns={'__name__':'__main__','__file__':script}",
      "exec(compile(src,script,'exec'),ns,ns)",
    ].join("; ");

    const args = [
      "-u", "-c", bootstrap, this.script,
      "--task", "t2v-1.3B",
      "--fp8",
      "--fp8_t5",
      "--video_size", "320", "576",
      "--video_length", "9",
      "--infer_steps", "6",
      "--fps", "8",
      "--prompt", "vanta resident startup",
      "--dit", this.dit,
      "--vae", this.vae,
      "--t5", this.t5,
      "--attn_mode", "sdpa",
      "--output_type", "video",
      "--vae_cache_cpu",
      "--save_path", this.residentDir,
      "--lora_weight", this.lora,
      "--lora_multiplier", "1.0",
      "--interactive",
    ];

    const child = spawn(this.python, args, {
      cwd: path.dirname(this.script),
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
    });
    this.resident = child;
    this.residentLog = "";
    const keepLog = chunk => {
      const text = chunk.toString();
      this.residentLog = (this.residentLog + text).slice(-64_000);
      if (
        text.includes("Interactive mode.") ||
        text.includes("VANTA resident: eager loading")
      ) {
        // "Interactive mode" means all eager startup loads completed.
        if (text.includes("Interactive mode.")) this.residentReady = true;
      }
    };
    child.stdout.on("data", keepLog);
    child.stderr.on("data", keepLog);
    child.on("close", () => {
      if (this.resident === child) this.resident = null;
      this.residentReady = false;
    });
    child.on("error", () => {
      if (this.resident === child) this.resident = null;
      this.residentReady = false;
    });
    return child;
  }

  async residentGenerate({ prompt, width, height, frames, steps, seed, signal, timeoutMs = 2_700_000 }) {
    const child = this.startResident();
    const readyStart = Date.now();
    while (!this.residentReady) {
      if (signal?.aborted) throw new RenderError("Generation cancelled.", 499);
      if (!this.resident || this.resident.killed)
        throw new Error("resident process exited during model load");
      if (Date.now() - readyStart > 900_000)
        throw new Error("resident model load timed out");
      await sleep(250);
    }
    const existing = new Set((await residentMp4s(this.residentDir)).map(item => item.file));
    const started = Date.now();

    const cleanPrompt = String(prompt || "VANTA motion")
      .replace(/[\r\n]+/g, " ")
      .replace(/ --/g, " —")
      .trim();
    const line =
      cleanPrompt +
      " --w " + width +
      " --h " + height +
      " --f " + frames +
      " --s " + steps +
      " --d " + seed +
      "\n";

    const abort = () => this.stopResident();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!child.stdin.writable) throw new Error("resident stdin unavailable");
      child.stdin.write(line);

      let lastFile = null;
      let lastSize = -1;
      let stableCount = 0;
      while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw new RenderError("Generation cancelled.", 499);
        if (!this.resident || this.resident.killed)
          throw new Error("resident process exited");

        const candidates = (await residentMp4s(this.residentDir))
          .filter(item => !existing.has(item.file) && item.mtime >= started - 1000)
          .sort((a, b) => b.mtime - a.mtime);
        const newest = candidates[0];
        if (newest && newest.size > 1024) {
          if (newest.file === lastFile && newest.size === lastSize) stableCount += 1;
          else {
            lastFile = newest.file;
            lastSize = newest.size;
            stableCount = 0;
          }
          if (stableCount >= 2) return newest.file;
        }
        await sleep(500);
      }
      throw new Error("resident generation timed out");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  get configured() {
    return [this.python, this.script, this.dit, this.vae, this.t5, this.lora]
      .every(file => existsSync(file));
  }

  _ready() {
    if (this.closed) throw new RenderError("VANTA Motion Core is restarting.", 503);
    if (!this.configured)
      throw new RenderError(
        "VANTA Motion Core files are missing. VANTA expects the existing XZAKUT_TRAINING_NATIVE Wan runtime and trained LoRA.",
        503,
      );
  }

  async enqueue(files, settings, signal) {
    if (files.length)
      throw new RenderError(
        "VANTA Motion Core is prompt-only while VANTA Reference Core is being trained. Reference images are intentionally disabled for now.",
        400,
      );
    const job = await super.enqueue(files, settings, signal);
    const size = renderProfile(job.format, job.speedMode);
    job.aiBackend = "vanta-motion";
    job.model = "VANTA Motion Core · " + String(job.speedMode || "turbo").toUpperCase();
    job.sourceResolution = size.width + "x" + size.height;
    job.inferenceSteps = size.steps;
    job.internalFps = size.fps;
    job.outputResolution = "1080p (upscaled)";
    job.upscaled = true;
    job.canCancel = true;
    job.cancelWarning = null;
    return job;
  }

  async run(job) {
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(job.id, controller);
    const work = this.work.get(job.id);
    job.status = "processing";
    job.progress = 1;
    try {
      const size = renderProfile(job.format, job.speedMode);
      const outDir = path.join(work.workDir, "wan-output");
      await mkdir(outDir, { recursive: true });
      const fps = size.fps;
      const frames = Math.max(9, Math.round(job.requestedDuration * fps) + 1);
      const normalizedFrames = frames + ((4 - ((frames - 1) % 4)) % 4);

      const seed = Math.floor(Math.random() * 2147483647);
      let rendered = null;
      job.progress = 12;

      // Prefer the resident worker for Turbo. Balanced/Quality use one-shot
      // because the upstream interactive prompt format cannot override FPS.
      const canUseResident = (job.speedMode || "turbo") === "turbo";

      // Prefer the resident worker. It loads the model once and reuses it across
      // generations, removing the repeated disk/model/LoRA setup cost.
      try {
        if (!canUseResident) throw new Error("resident turbo only");
        // Do not block the user's first render on a background warm-up render.
        // If warm-up is still running, use the already-started resident process.
        const residentFile = await this.residentGenerate({
          prompt: job.prompt,
          width: size.width,
          height: size.height,
          frames: normalizedFrames,
          steps: size.steps,
          seed,
          signal,
        });
        rendered = path.join(outDir, "resident-source.mp4");
        await rename(residentFile, rendered);
      } catch (residentError) {
        if (signal.aborted) throw residentError;
        this.stopResident();

        // Safe fallback: one-shot generation still works if the resident process
        // cannot start on this Windows/Python setup.
        const args = [
          this.script,
          "--task", "t2v-1.3B",
          "--fp8",
          "--fp8_t5",
          "--video_size", String(size.height), String(size.width),
          "--video_length", String(normalizedFrames),
          "--infer_steps", String(size.steps),
          "--fps", String(fps),
          "--prompt", job.prompt,
          "--dit", this.dit,
          "--vae", this.vae,
          "--t5", this.t5,
          "--attn_mode", "sdpa",
          "--seed", String(seed),
          "--output_type", "video",
          "--vae_cache_cpu",
          "--save_path", outDir,
          "--lora_weight", this.lora,
          "--lora_multiplier", "1.0",
        ];
        await execute(this.python, args, {
          cwd: path.dirname(this.script),
          signal,
          maxMs: 2_700_000,
        });

        const names = await readdir(outDir, { recursive: true });
        const videos = [];
        for (const name of names) {
          if (typeof name !== "string" || !name.toLowerCase().endsWith(".mp4")) continue;
          const candidate = path.join(outDir, name);
          try {
            const info = await stat(candidate);
            if (info.isFile()) videos.push({ path: candidate, mtime: info.mtimeMs });
          } catch {}
        }
        videos.sort((a, b) => b.mtime - a.mtime);
        if (!videos.length) throw new RenderError("VANTA Motion Core finished without an MP4.", 502);
        rendered = videos[0].path;
      }
      job.progress = 78;
      const source = await probe(this.ffprobePath, rendered, signal);

      const filter = "scale=" + job.width + ":" + job.height +
        ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos," +
        "pad=" + job.width + ":" + job.height + ":(ow-iw)/2:(oh-ih)/2," +
        "fps=24,setsar=1,format=yuv420p";
      await execute(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", rendered, "-map", "0:v:0", "-an",
        "-vf", filter, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        this.partialPath(job.id),
      ], { signal, maxMs: 180_000 });

      const result = await probe(this.ffprobePath, this.partialPath(job.id), signal);
      if (result.width !== job.width || result.height !== job.height)
        throw new RenderError("VANTA Motion Core 1080p export failed validation.", 502);

      await rename(this.partialPath(job.id), this.filePath(job.id));

      job.progress = 90;
      const audio = await this.audioService.apply({
        soundMode: job.soundMode,
        videoPath: this.filePath(job.id),
        prompt: job.prompt,
        workDir: work.workDir,
        signal,
      });
      job.hasAudio = audio.hasAudio;
      job.audioEngine = audio.audioEngine;
      job.warning = audio.warning;

      job.status = "completed";
      job.progress = 100;
      job.duration = result.duration;
      job.addedDuration = result.duration;
      job.sourceWidth = source.width;
      job.sourceHeight = source.height;
      job.completedAt = new Date().toISOString();
      const temp = this.metadataPath(job.id) + ".tmp";
      await writeFile(temp, JSON.stringify(this.publicJob(job), null, 2), { mode: 0o600 });
      await rename(temp, this.metadataPath(job.id));
      await this.prune();
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = error instanceof RenderError ? error.message : "VANTA Motion Core failed.";
      for (const file of [
        this.partialPath(job.id), this.filePath(job.id),
        this.metadataPath(job.id), this.metadataPath(job.id) + ".tmp",
      ]) await rm(file, { force: true }).catch(() => {});
    } finally {
      this.controllers.delete(job.id);
      await this.cleanupSources(job.id);
    }
  }

  async close() {
    this.stopResident();
    await super.close();
  }
}
