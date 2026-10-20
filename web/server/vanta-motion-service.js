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
          ? "GPU memory ran out in VANTA Motion Core. Close other GPU apps or use a shorter clip."
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

function sourceSize(format) {
  if (format === "portrait") return { height: 832, width: 480 };
  if (format === "square") return { height: 480, width: 480 };
  return { height: 480, width: 832 };
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
    const size = sourceSize(job.format);
    job.aiBackend = "vanta-motion";
    job.model = "VANTA Motion Core · trained local motion stack";
    job.sourceResolution = size.width + "x" + size.height;
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
      const size = sourceSize(job.format);
      const outDir = path.join(work.workDir, "wan-output");
      await mkdir(outDir, { recursive: true });
      const fps = 16;
      const frames = Math.max(17, Math.round(job.requestedDuration * fps) + 1);
      const normalizedFrames = frames + ((4 - ((frames - 1) % 4)) % 4);

      const args = [
        this.script,
        "--task", "t2v-1.3B",
        "--fp8",
        "--video_size", String(size.height), String(size.width),
        "--video_length", String(normalizedFrames),
        "--infer_steps", "12",
        "--fps", String(fps),
        "--prompt", job.prompt,
        "--dit", this.dit,
        "--vae", this.vae,
        "--t5", this.t5,
        "--attn_mode", "torch",
        "--seed", String(Math.floor(Math.random() * 2147483647)),
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
      job.progress = 78;

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
      const rendered = videos[0].path;
      const source = await probe(this.ffprobePath, rendered, signal);

      const filter = "scale=" + job.width + ":" + job.height +
        ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos," +
        "pad=" + job.width + ":" + job.height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p";
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
}
