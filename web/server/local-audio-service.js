// Optional local video-to-audio post-processor.
// Primary target: HunyuanVideo-Foley XL, run after video generation so VRAM is
// released by the video model first. No cloud API or per-generation credits.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ROOT = "P:\\GROK\\VANTA_AUDIO\\HunyuanVideo-Foley";

function run(command, args, { cwd, signal, maxMs = 1_800_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HUB_DISABLE_TELEMETRY: "1",
        HF_HOME: process.env.VANTA_AUDIO_HF_HOME || "P:\\GROK\\VANTA_AUDIO\\HF_CACHE",
        TRANSFORMERS_CACHE: process.env.VANTA_AUDIO_HF_HOME || "P:\\GROK\\VANTA_AUDIO\\HF_CACHE",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, maxMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk.toString()).slice(-48_000);
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-48_000);
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (signal?.aborted) return finish(new Error("cancelled"));
      if (timedOut) return finish(new Error("audio timed out"));
      if (code !== 0)
        return finish(new Error((stderr || stdout || "audio process failed").slice(-8000)));
      finish();
    });
  });
}

async function findNewestAudio(root) {
  const entries = await readdir(root, { recursive: true });
  const found = [];
  for (const name of entries) {
    if (
      typeof name !== "string" ||
      !/\.(wav|flac|mp3|m4a|aac|ogg)$/i.test(name)
    ) continue;
    const file = path.join(root, name);
    try {
      const info = await stat(file);
      if (info.isFile()) found.push({ file, mtime: info.mtimeMs });
    } catch {}
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.file ?? null;
}

export class LocalAudioService {
  constructor({ ffmpegPath = "ffmpeg" } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.root = path.resolve(process.env.VANTA_FOLEY_DIR || DEFAULT_ROOT);
    this.python =
      process.env.VANTA_FOLEY_PYTHON ||
      path.join(this.root, "venv", "Scripts", "python.exe");
    this.script =
      process.env.VANTA_FOLEY_SCRIPT || path.join(this.root, "infer.py");
    this.modelDir =
      process.env.VANTA_FOLEY_MODEL_DIR || path.join(this.root, "pretrained_models");
    this.modelSize = process.env.VANTA_FOLEY_MODEL_SIZE || "xl";
  }

  get configured() {
    return (
      existsSync(this.python) &&
      existsSync(this.script) &&
      existsSync(this.modelDir)
    );
  }

  describe() {
    return this.configured
      ? "HunyuanVideo-Foley XL local"
      : "HunyuanVideo-Foley XL not installed";
  }

  async apply({
    soundMode,
    speedMode = "turbo",
    videoPath,
    prompt,
    workDir,
    signal,
  }) {
    if (soundMode !== "auto")
      return { hasAudio: false, audioEngine: null, warning: null };

    if (!this.configured) {
      return {
        hasAudio: false,
        audioEngine: null,
        warning:
          "Auto Sound was selected, but HunyuanVideo-Foley XL is not installed yet. The video was exported silently.",
      };
    }

    const audioDir = path.join(workDir, "generated-audio");
    await mkdir(audioDir, { recursive: true });
    const audioPrompt =
      "Create realistic synchronized production audio for this exact video. " +
      "Match visible actions frame-by-frame, preserve natural room ambience, " +
      "use believable impact/cloth/footstep/environment sounds, avoid random music unless the scene explicitly calls for it. " +
      "Scene description: " +
      String(prompt || "").trim();

    try {
      const stepMap = { turbo: 12, balanced: 20, quality: 30 };
      const audioSteps = stepMap[speedMode] || 12;
      const args = [
        this.script,
        "--model_path", this.modelDir,
        "--model_size", this.modelSize,
        "--num_inference_steps", String(audioSteps),
        "--device", "cuda",
        "--single_video", videoPath,
        "--single_prompt", audioPrompt,
        "--output_dir", audioDir,
        "--enable_offload",
      ];
      await run(this.python, args, {
        cwd: this.root,
        signal,
        maxMs: 1_800_000,
      });

      const audioPath = await findNewestAudio(audioDir);
      if (!audioPath) throw new Error("Foley model returned no audio file");

      const muxed = path.join(workDir, "with-audio.mp4");
      await run(
        this.ffmpegPath,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-i", videoPath,
          "-i", audioPath,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c:v", "copy",
          "-af", "aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11",
          "-c:a", "aac",
          "-b:a", "256k",
          "-ar", "48000",
          "-shortest",
          "-movflags", "+faststart",
          muxed,
        ],
        { signal, maxMs: 180_000 },
      );
      await rm(videoPath, { force: true });
      await rename(muxed, videoPath);
      return {
        hasAudio: true,
        audioEngine: "HunyuanVideo-Foley XL",
        warning: null,
      };
    } catch (error) {
      return {
        hasAudio: false,
        audioEngine: null,
        warning:
          "The local Auto Sound pass failed, so VANTA kept the finished silent video. " +
          (error instanceof Error ? error.message.slice(0, 300) : ""),
      };
    }
  }
}
