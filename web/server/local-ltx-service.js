// Credit-free AI image-to-video using an existing local LTX-Video installation.
// No xAI API calls are made by this service. It inherits only local job storage,
// input validation, serialization, queueing, and cleanup from XaiService.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { XaiService } from "./xai-service.js";
import { RenderError } from "./renderer.js";

const WINDOWS_LTX = "P:\\grok\\AXG-Motion\\LTX-Video";
const WINDOWS_PYTHON = "P:\\grok\\AXG-Motion\\env\\Scripts\\python.exe";
const CONFIGS = [
  "ltxv-2b-0.9.8-distilled.yaml",
  "ltxv-2b-0.9.6-distilled.yaml",
  "ltxv-2b-0.9.6-dev.yaml",
];

function findConfig(repoDir) {
  if (process.env.LTX_CONFIG) {
    return path.isAbsolute(process.env.LTX_CONFIG)
      ? process.env.LTX_CONFIG
      : path.join(repoDir, process.env.LTX_CONFIG);
  }
  for (const name of CONFIGS) {
    const candidate = path.join(repoDir, "configs", name);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(repoDir, "configs", CONFIGS[0]);
}

function outputSize(format) {
  if (format === "portrait") return { width: 288, height: 512 };
  if (format === "square") return { width: 384, height: 384 };
  return { width: 512, height: 288 };
}

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
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk.toString()).slice(-32_000);
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-32_000);
    });
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    child.once("error", error => finish(new RenderError(
      error.code === "ENOENT"
        ? "A local program was not found. Check LTX_PYTHON, FFmpeg, and ffprobe paths."
        : "The local video engine could not start.", 503
    )));
    child.once("close", code => {
      if (signal?.aborted) return finish(new RenderError("Generation cancelled.", 499));
      if (timedOut) return finish(new RenderError("Local GPU render exceeded 45 minutes. Try a 3-second scene.", 504));
      if (code !== 0) {
        const details = (stderr + "\n" + stdout).toLowerCase();
        const message = /out of memory|cuda.*memory|cuda error/.test(details)
          ? "GPU memory ran out. Close other GPU apps, choose a 3-second video, then retry."
          : /no module named|modulenotfounderror/.test(details)
          ? "The local LTX Python environment is missing dependencies. Fix the existing LTX installation."
          : /no such file|filenotfounderror|not found|can't open file/.test(details)
          ? "An LTX model or dependency file is missing. Check the LTX config and model files."
          : "Local LTX generation failed. Inspect its Python terminal and model setup; no credits were charged.";
        return finish(new RenderError(message, 502));
      }
      finish();
    });
  });
}

async function probe(ffprobePath, file, signal) {
  const response = await execute(ffprobePath, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration",
    "-of", "json", file,
  ], { signal, maxMs: 30_000 });
  let parsed;
  try { parsed = JSON.parse(response.stdout); } catch { /* reject below */ }
  const video = parsed?.streams?.[0];
  const duration = Number(parsed?.format?.duration);
  if (!video || !video.width || !video.height || !Number.isFinite(duration) || duration <= 0)
    throw new RenderError("The local AI did not return a valid video.", 502);
  return { ...video, duration };
}

export class LocalLtxService extends XaiService {
  constructor(options) {
    super({ ...options, apiKey: "local-engine-no-api-key" });
    this.repoDir = path.resolve(process.env.LTX_DIR ||
      (process.platform === "win32" ? WINDOWS_LTX : ""));
    this.python = process.env.LTX_PYTHON ||
      (process.platform === "win32" ? WINDOWS_PYTHON : "python3");
    this.config = findConfig(this.repoDir);
    this.maxReferenceImages = 4;
  }

  get configured() {
    return existsSync(path.join(this.repoDir, "inference.py")) &&
      existsSync(this.config) &&
      (!path.isAbsolute(this.python) || existsSync(this.python));
  }

  _ready() {
    if (this.closed) throw new RenderError("The local AI engine is restarting.", 503);
    if (!this.configured)
      throw new RenderError(
        "Local LTX is not configured. Expected P:\\grok\\AXG-Motion\\LTX-Video and P:\\grok\\AXG-Motion\\env\\Scripts\\python.exe, or set LTX_DIR/LTX_PYTHON manually. No credits or API key are required.",
        503
      );
  }

  async enqueue(files, settings, signal) {
    const job = await super.enqueue(files, settings, signal);
    const resolution = outputSize(job.format);
    job.model = "LTX-Video 2B (local GPU)";
    job.sourceResolution = String(resolution.width) + "x" + String(resolution.height);
    job.outputResolution = "1080p (upscaled)";
    job.canCancel = true;
    job.cancelWarning = null;
    job.upscaled = true;
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
      if (!work?.images?.length) throw new RenderError("Starting photo was not found.", 400);
      const size = outputSize(job.format);
      const outputDir = path.join(work.workDir, "generated");
      await mkdir(outputDir, { recursive: true });

      // Prepare every selected reference at the same bounded render size.
      // The user-selected background reference is placed first and receives
      // full conditioning strength; other references guide identity/outfit
      // without being allowed to dominate the environment as strongly.
      const prepared = [];
      for (let index = 0; index < work.images.length; index += 1) {
        const input = path.join(work.workDir, "condition-" + index + ".png");
        await execute(this.ffmpegPath, [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-i", work.images[index].path,
          "-vf", "scale=" + size.width + ":" + size.height +
            ":force_original_aspect_ratio=decrease,pad=" + size.width + ":" + size.height +
            ":(ow-iw)/2:(oh-ih)/2,format=rgb24",
          "-frames:v", "1", input,
        ], { signal, maxMs: 60_000 });
        prepared.push(input);
      }
      job.progress = 10;

      const frames = job.requestedDuration * 24 + 1;
      const backgroundIndex = Math.min(
        Math.max(Number(job.backgroundIndex) || 0, 0),
        prepared.length - 1,
      );
      const order = [
        backgroundIndex,
        ...prepared.map((_, index) => index).filter(index => index !== backgroundIndex),
      ];
      const conditioningPaths = order.map(index => prepared[index]);
      const conditioningFrames = conditioningPaths.map(() => "0");
      const conditioningStrengths = order.map((index, position) =>
        position === 0 ? "1.0" : (job.keepIdentity || job.keepOutfit ? "0.62" : "0.42")
      );

      const constraints = [];
      constraints.push(
        "Use the environment, room, scenery, lighting context, and background composition from the primary background reference. Do not replace that background with the other references."
      );
      if (job.keepIdentity) constraints.push(
        "Preserve each referenced person's identity, face shape, skin tone, hair, and distinguishing appearance consistently throughout the shot."
      );
      if (job.keepOutfit) constraints.push(
        "Preserve the referenced clothing, makeup, accessories, hair styling, and outfit details unless the user's prompt explicitly asks for a change."
      );
      constraints.push(
        "Treat the remaining reference images as appearance references, not as instructions to replace the selected background."
      );
      const modelPrompt = job.prompt.trim() + "\n\nREFERENCE RULES: " + constraints.join(" ");

      const inferenceArgs = [
        path.join(this.repoDir, "inference.py"),
        "--prompt", modelPrompt,
        "--conditioning_media_paths", ...conditioningPaths,
        "--conditioning_start_frames", ...conditioningFrames,
        "--conditioning_strengths", ...conditioningStrengths,
        "--width", String(size.width),
        "--height", String(size.height),
        "--num_frames", String(frames),
        "--frame_rate", "24",
        "--seed", String(Math.floor(Math.random() * 2147483647)),
        "--pipeline_config", this.config,
        "--output_path", outputDir,
        "--offload_to_cpu",
      ];

      // Official LTX-Video accepts multiple conditioning media items. All
      // inference remains local; there is no paid API or cloud generation call.
      await execute(this.python, inferenceArgs, {
        cwd: this.repoDir,
        signal,
        maxMs: 2_700_000,
      });
      job.progress = 80;
      const videos = (await readdir(outputDir, { recursive: true }))
        .filter(name => typeof name === "string" && name.toLowerCase().endsWith(".mp4"))
        .sort();
      if (videos.length !== 1)
        throw new RenderError("LTX must produce exactly one MP4 for this scene. Check the selected model configuration.", 502);
      const rendered = path.join(outputDir, videos[0]);
      if (!(await stat(rendered)).isFile())
        throw new RenderError("LTX output was not a video file.", 502);
      const source = await probe(this.ffprobePath, rendered, signal);
      const scaleFilter = "scale=" + job.width + ":" + job.height +
        ":force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos," +
        "pad=" + job.width + ":" + job.height + ":(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p";
      await execute(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", rendered, "-map", "0:v:0", "-an",
        "-vf", scaleFilter, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        this.partialPath(job.id),
      ], { signal, maxMs: 180_000 });
      const result = await probe(this.ffprobePath, this.partialPath(job.id), signal);
      if (result.codec_name !== "h264" || result.width !== job.width ||
          result.height !== job.height || Math.abs(result.duration - source.duration) > 0.3)
        throw new RenderError("The local 1080p MP4 failed validation.", 502);
      if (signal.aborted) throw new RenderError("Generation cancelled.", 499);
      await rename(this.partialPath(job.id), this.filePath(job.id));
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
      job.error = error instanceof RenderError ? error.message :
        "The local LTX model failed. Check its Python dependencies and model assets.";
      for (const file of [this.partialPath(job.id), this.filePath(job.id),
        this.metadataPath(job.id), this.metadataPath(job.id) + ".tmp"]) {
        const { rm } = await import("node:fs/promises");
        await rm(file, { force: true }).catch(() => {});
      }
    } finally {
      this.controllers.delete(job.id);
      await this.cleanupSources(job.id);
      const failed = [...this.jobs.values()].filter(entry =>
        ["failed", "cancelled"].includes(entry.status));
      for (const old of failed.slice(0, Math.max(0, failed.length - 50)))
        this.jobs.delete(old.id);
    }
  }
}
