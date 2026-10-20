import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { FORMATS, inspectImage, RenderError } from "./renderer.js";
import { MAX_PROMPT_LENGTH } from "../shared/prompt.js";

const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MODEL = "grok-imagine-video-1.5";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const CANCEL_WARNING =
  "Removing this job stops local waiting only. xAI does not support cancelling video generation; the remote job may continue and incur charges.";
const POLL_TIMEOUT_MESSAGE =
  "xAI video generation timed out. The remote job may still finish and incur charges; check your xAI account.";
const MIME_TYPES = {
  png_pipe: "image/png",
  jpeg_pipe: "image/jpeg",
  webp_pipe: "image/webp",
};
const ASPECT_RATIOS = { landscape: "16:9", portrait: "9:16", square: "1:1" };
const clean = (file) => rm(file, { force: true, recursive: true }).catch(() => {});

function cancelled(signal) {
  if (signal?.aborted) throw new RenderError("Local waiting stopped. The remote xAI generation may still continue and incur charges.", 499);
}

async function bounded(signal, timeout, operation, timeoutMessage) {
  cancelled(signal);
  const controller = new AbortController();
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new RenderError("Local waiting stopped. The remote xAI generation may still continue and incur charges.", 499));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new RenderError(timeoutMessage, 504));
    }, Math.max(1, timeout));
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new RenderError("Local waiting stopped. The remote xAI generation may still continue and incur charges.", 499));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function readBody(response, limit, signal, onChunk) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new RenderError("The xAI response exceeds the safe download size limit.", 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      cancelled(signal);
      const { done, value } = await reader.read();
      cancelled(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new RenderError("The xAI response exceeds the safe download size limit.", 502);
      if (onChunk) await onChunk(value);
      else chunks.push(Buffer.from(value));
    }
    return onChunk ? bytes : Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function runTool(command, args, { signal, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    try { cancelled(signal); } catch (error) { reject(error); return; }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-256_000); });
    // Drain diagnostics without exposing temporary provider URLs or private paths.
    child.stderr.on("data", () => {});
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.on("error", () => finish(new RenderError("Required video tools are unavailable. Install FFmpeg and ffprobe.", 503)));
    child.on("close", code => {
      if (signal?.aborted) return finish(new RenderError("Local waiting stopped. The remote xAI generation may still continue and incur charges.", 499));
      if (timedOut) return finish(new RenderError("Video export timed out. Try generating again.", 504));
      if (code !== 0) return finish(new RenderError("The xAI video could not be decoded or exported. Try generating again.", 502));
      finish();
    });
  });
}

export class XaiService {
  constructor({
    dataDir,
    apiKey = process.env.XAI_API_KEY,
    fetchImpl = fetch,
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    pollIntervalMs = 5000,
    pollTimeoutMs = 600_000,
    maxPending = 2,
    maxCompleted = 50,
    apiBase = "https://api.x.ai/v1",
  }) {
    if (apiBase.replace(/\/$/, "") !== "https://api.x.ai/v1")
      throw new TypeError("xAI API requests must use https://api.x.ai/v1.");
    this.dataDir = path.resolve(dataDir);
    this.uploadDir = path.join(this.dataDir, "ai-uploads");
    this.videoDir = path.join(this.dataDir, "ai-videos");
    this.apiKey = typeof apiKey === "string" ? apiKey.trim() : "";
    this.fetchImpl = fetchImpl;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.pollIntervalMs = Math.max(1, pollIntervalMs);
    this.pollTimeoutMs = Math.max(1, pollTimeoutMs);
    this.maxPending = maxPending;
    this.maxCompleted = maxCompleted;
    this.minReferenceImages = 1;
    this.maxReferenceImages = 3;
    this.jobs = new Map();
    this.work = new Map();
    this.controllers = new Map();
    this.tasks = new Map();
    this.queue = [];
    this.reservations = 0;
    this.validations = 0;
    this.current = null;
    this.closed = false;
  }

  get configured() { return Boolean(this.apiKey); }

  async init() {
    await Promise.all([
      mkdir(this.uploadDir, { recursive: true }),
      mkdir(this.videoDir, { recursive: true }),
    ]);
    for (const entry of await readdir(this.uploadDir)) await clean(path.join(this.uploadDir, entry));
    for (const entry of await readdir(this.videoDir)) {
      if (entry.endsWith(".partial.mp4") || entry.endsWith(".json.tmp")) await clean(path.join(this.videoDir, entry));
      if (!entry.endsWith(".json")) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.videoDir, entry), "utf8"));
        if (!ID_PATTERN.test(job.id) || entry !== `${job.id}.json` || job.status !== "completed" || job.engine !== "ai" || !Object.hasOwn(FORMATS, job.format)) continue;
        if (!(await stat(this.filePath(job.id))).isFile()) continue;
        this.jobs.set(job.id, this.publicJob(job));
      } catch { /* Ignore incomplete metadata; never use it as a path. */ }
    }
    for (const entry of await readdir(this.videoDir)) {
      if (entry.endsWith(".mp4") && ID_PATTERN.test(entry.slice(0, -4)) && !this.jobs.has(entry.slice(0, -4)))
        await clean(path.join(this.videoDir, entry));
    }
    await this.prune();
  }

  _path(id, suffix) {
    if (!ID_PATTERN.test(id)) throw new RenderError("Video not found.", 404);
    return path.join(this.videoDir, `${id}${suffix}`);
  }
  filePath(id) { return this._path(id, ".mp4"); }
  partialPath(id) { return this._path(id, ".partial.mp4"); }
  metadataPath(id) { return this._path(id, ".json"); }

  pendingCount() {
    return this.reservations + [...this.jobs.values()].filter(job => ["queued", "processing"].includes(job.status)).length;
  }
  _ready() {
    if (this.closed) throw new RenderError("The AI video service is restarting. Try again shortly.", 503);
    if (!this.configured) throw new RenderError("AI generation needs an xAI API key. Add XAI_API_KEY securely in Environment settings, then restart the server.", 503);
  }
  reserve() {
    this._ready();
    if (this.pendingCount() >= this.maxPending) throw new RenderError("The AI generation queue is full. Wait for a video to finish, then try again.", 429);
    this.reservations += 1;
    let released = false;
    return () => { if (!released) { released = true; this.reservations -= 1; } };
  }

  publicJob(job) {
    const fields = ["id", "status", "progress", "createdAt", "completedAt", "engine", "aiBackend", "model", "extendable", "canCancel", "cancelWarning", "prompt", "motion", "parentId", "requestedDuration", "duration", "addedDuration", "imageCount", "backgroundIndex", "keepIdentity", "keepOutfit", "soundMode", "speedMode", "stage", "audioEngine", "hasAudio", "warning", "format", "width", "height", "sourceWidth", "sourceHeight", "sourceResolution", "outputResolution", "upscaled", "filename", "mimeType", "extension", "error"];
    return {
      ...Object.fromEntries(fields.filter(field => Object.hasOwn(job, field)).map(field => [field, job[field]])),
      fileUrl: job.status === "completed" ? `/api/videos/${job.id}/file` : null,
    };
  }
  get(id) { return this.jobs.get(id); }
  list() {
    return [...this.jobs.values()].filter(job => job.status === "completed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(job => this.publicJob(job));
  }

  async enqueue(files, { prompt, duration, format, parentId = null, backgroundIndex = 0, keepIdentity = true, keepOutfit = true, aiBackend = "vanta-motion", soundMode = "silent", speedMode = "hyper" }, signal) {
    this._ready();
    cancelled(signal);
    if (parentId) throw new RenderError("AI video extension is not supported. Create a new AI video, or extend a camera-motion video.", 422);
    if (!Array.isArray(files) || files.length < this.minReferenceImages || files.length > this.maxReferenceImages)
      throw new RenderError(
        this.minReferenceImages === 0 && this.maxReferenceImages === 0
          ? "This trained motion engine is prompt-only and does not accept reference images."
          : `AI generation supports between ${this.minReferenceImages} and ${this.maxReferenceImages} reference images.`,
        400
      );
    if (files.length > 0 && (!Number.isInteger(backgroundIndex) || backgroundIndex < 0 || backgroundIndex >= files.length))
      throw new RenderError("Choose which reference image supplies the scene background.", 400);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_PROMPT_LENGTH)
      throw new RenderError(`Describe your AI video in a prompt of 1 to ${MAX_PROMPT_LENGTH} characters.`, 400);
    if (![3, 5, 10].includes(duration) || !Object.hasOwn(FORMATS, format))
      throw new RenderError("Choose a duration of 3, 5, or 10 seconds and a supported format.", 400);
    const pending = [...this.jobs.values()].filter(job => ["queued", "processing"].includes(job.status)).length;
    if (pending + this.validations >= this.maxPending)
      throw new RenderError("The AI generation queue is full. Wait for a video to finish, then try again.", 429);
    this.validations += 1;
    let workDir;
    let accepted = false;
    try {
      const images = [];
      let totalBytes = 0;
      for (const file of files) {
        if (!file || typeof file.path !== "string") throw new RenderError("Choose valid JPEG, PNG, or WebP reference images.", 400);
        const info = await stat(file.path);
        if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES)
          throw new RenderError("Each reference image must be nonempty and no larger than 20 MB.", 413);
        totalBytes += info.size;
        if (totalBytes > 60 * 1024 * 1024) throw new RenderError("Reference images exceed the 60 MB total upload limit.", 413);
        const image = await inspectImage(file.path, { ffprobePath: this.ffprobePath, signal });
        images.push({ path: file.path, mimeType: MIME_TYPES[image.demuxer] });
      }
      cancelled(signal);
      this._ready();
      const id = randomUUID();
      workDir = await mkdtemp(path.join(this.uploadDir, `${id}-`));
      cancelled(signal);
      this._ready();
      const job = {
        id, status: "queued", progress: 0, createdAt: new Date().toISOString(), completedAt: null,
        engine: "ai", model: MODEL, extendable: false, canCancel: false, cancelWarning: CANCEL_WARNING,
        prompt, motion: null, parentId: null, requestedDuration: duration, duration, addedDuration: duration,
        imageCount: images.length, backgroundIndex, keepIdentity: Boolean(keepIdentity), keepOutfit: Boolean(keepOutfit), aiBackend, soundMode, speedMode, stage: "queued", audioEngine: null, hasAudio: false, format, ...FORMATS[format], sourceResolution: "720p", outputResolution: "1080p", upscaled: true,
        filename: `vanta-ai-${id.slice(0, 8)}.mp4`, mimeType: "video/mp4", extension: "mp4", error: null,
      };
      this.jobs.set(id, job);
      this.work.set(id, { images, workDir });
      this.queue.push(id);
      accepted = true;
      setImmediate(() => this.pump());
      return job;
    } finally {
      this.validations -= 1;
      if (!accepted && workDir) await clean(workDir);
    }
  }

  pump() {
    if (this.current || this.closed) return;
    let job;
    while (this.queue.length && !job) job = this.jobs.get(this.queue.shift());
    if (!job) return;
    this.current = job.id;
    const task = this.run(job).finally(() => {
      this.tasks.delete(job.id);
      this.current = null;
      this.pump();
    });
    this.tasks.set(job.id, task);
  }

  async requestJson(endpoint, { method = "GET", body, signal, timeout = 30_000, pending = false, timeoutMessage = "The xAI request timed out. Check your xAI account before retrying a generation." } = {}) {
    try {
      return await bounded(signal, timeout, async requestSignal => {
        const response = await this.fetchImpl(`https://api.x.ai/v1${endpoint}`, {
          method,
          headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error", signal: requestSignal,
        });
        if (pending && response.status === 202) {
          await response.body?.cancel().catch(() => {});
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if ([401, 403].includes(response.status)) throw new RenderError("xAI rejected the API key. Update XAI_API_KEY securely in Environment settings.", 502);
          if (response.status === 429) throw new RenderError("xAI's rate or spending limit was reached. Check your xAI account limits before retrying.", 503);
          throw new RenderError("The xAI video service returned an error. Check your xAI account and try again later.", 502);
        }
        const bytes = await readBody(response, 1024 * 1024, requestSignal);
        try { return JSON.parse(bytes.toString("utf8")); }
        catch { throw new RenderError("xAI returned an invalid video response. Try again later.", 502); }
      }, timeoutMessage);
    } catch (error) {
      if (error instanceof RenderError) throw error;
      cancelled(signal);
      throw new RenderError("Unable to reach xAI. Check the API connection and try again later.", 502);
    }
  }

  async waitForVideo(requestId, signal) {
    const deadline = Date.now() + this.pollTimeoutMs;
    while (Date.now() < deadline) {
      const result = await this.requestJson(`/videos/${encodeURIComponent(requestId)}`, {
        signal, pending: true, timeout: Math.min(30_000, deadline - Date.now()), timeoutMessage: POLL_TIMEOUT_MESSAGE,
      });
      if (result?.status === "done") {
        if (result.video?.respect_moderation === false || result.respect_moderation === false)
          throw new RenderError("xAI did not release this video because of moderation. Review your images and prompt before trying again.", 422);
        if (typeof result.video?.url !== "string") throw new RenderError("xAI finished without a downloadable video. Try again later.", 502);
        return result.video.url;
      }
      if (["failed", "expired"].includes(result?.status))
        throw new RenderError(result.status === "expired" ? "The xAI video generation expired. Check your xAI account before trying again." : "xAI could not generate this video. Review your images and prompt, and check your xAI account before retrying.", 502);
      if (result && !["pending", "queued", "processing", "running"].includes(result.status))
        throw new RenderError("xAI returned an unexpected generation status. Check your xAI account before retrying.", 502);
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
    throw new RenderError(POLL_TIMEOUT_MESSAGE, 504);
  }

  async download(url, outputPath, signal) {
    let parsed;
    try { parsed = new URL(url); } catch { /* rejected below */ }
    if (!parsed || parsed.protocol !== "https:" || parsed.hostname !== "vidgen.x.ai" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443"))
      throw new RenderError("xAI returned an untrusted video download URL. The video was not downloaded.", 502);
    try {
      await bounded(signal, 60_000, async requestSignal => {
        // A signed CDN URL receives no API authorization header and cannot redirect.
        const response = await this.fetchImpl(parsed.href, { method: "GET", redirect: "error", signal: requestSignal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new RenderError("The xAI video download failed. Check your xAI account and try again later.", 502);
        }
        const file = await open(outputPath, "wx", 0o600);
        try {
          const size = await readBody(response, MAX_DOWNLOAD_BYTES, requestSignal, chunk => file.writeFile(chunk));
          if (!size) throw new RenderError("xAI returned an empty video download. Try again later.", 502);
        } finally { await file.close(); }
      }, "The xAI video download timed out. Check your xAI account before trying again.");
    } catch (error) {
      if (error instanceof RenderError) throw error;
      cancelled(signal);
      throw new RenderError("The xAI video download failed. Check your connection and try again later.", 502);
    }
  }

  async probe(file, signal) {
    const raw = await runTool(this.ffprobePath, [
      "-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", file,
    ], { signal, timeout: 15_000 });
    let result;
    try { result = JSON.parse(raw); } catch { /* rejected below */ }
    const stream = result?.streams?.[0];
    const duration = Number(result?.format?.duration);
    if (!stream || !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width < 2 || stream.height < 2 || stream.width > 4096 || stream.height > 4096 || !Number.isFinite(duration) || duration <= 0 || duration > 15)
      throw new RenderError("The xAI video failed validation. Try generating again.", 502);
    return { ...stream, duration };
  }

  async run(job) {
    const controller = new AbortController();
    const { signal } = controller;
    this.controllers.set(job.id, controller);
    const work = this.work.get(job.id);
    job.status = "processing";
    job.progress = 1;
    try {
      const reference_images = [];
      for (const image of work.images) {
        cancelled(signal);
        const data = await readFile(image.path);
        if (!data.length || data.length > MAX_IMAGE_BYTES) throw new RenderError("A reference image changed during generation. Choose your images again.", 400);
        reference_images.push({ url: `data:${image.mimeType};base64,${data.toString("base64")}` });
      }
      const result = await this.requestJson("/videos/generations", {
        method: "POST", signal,
        body: { model: MODEL, prompt: job.prompt, duration: job.requestedDuration, aspect_ratio: ASPECT_RATIOS[job.format], resolution: "720p", reference_images },
      });
      if (typeof result?.request_id !== "string" || !result.request_id || result.request_id.length > 256)
        throw new RenderError("xAI did not return a generation ID. Check your xAI account before retrying.", 502);
      job.progress = 20;
      const sourceUrl = await this.waitForVideo(result.request_id, signal);
      job.progress = 70;
      const sourcePath = path.join(work.workDir, "source.mp4");
      await this.download(sourceUrl, sourcePath, signal);
      const source = await this.probe(sourcePath, signal);
      job.progress = 85;
      const filter = `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${job.width}:${job.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`;
      await runTool(this.ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "2", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", sourcePath,
        "-map", "0:v:0", "-map", "0:a:0?", "-filter_threads", "1", "-vf", filter,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", this.partialPath(job.id),
      ], { signal });
      const output = await this.probe(this.partialPath(job.id), signal);
      if (output.codec_name !== "h264" || output.pix_fmt !== "yuv420p" || output.width !== job.width || output.height !== job.height || Math.abs(output.duration - source.duration) > 0.15)
        throw new RenderError("The 1080p export failed validation. Try generating again.", 502);
      cancelled(signal);
      await rename(this.partialPath(job.id), this.filePath(job.id));
      job.duration = output.duration;
      job.addedDuration = output.duration;
      job.sourceWidth = source.width;
      job.sourceHeight = source.height;
      job.status = "completed";
      job.progress = 100;
      job.completedAt = new Date().toISOString();
      const temporary = `${this.metadataPath(job.id)}.tmp`;
      await writeFile(temporary, JSON.stringify(this.publicJob(job), null, 2), { mode: 0o600 });
      await rename(temporary, this.metadataPath(job.id));
      await this.prune();
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "failed";
      job.error = error instanceof RenderError ? error.message : "AI video generation failed. Check your xAI account before trying again.";
      await Promise.all([clean(this.partialPath(job.id)), clean(this.filePath(job.id)), clean(this.metadataPath(job.id)), clean(`${this.metadataPath(job.id)}.tmp`)]);
    } finally {
      this.controllers.delete(job.id);
      await this.cleanupSources(job.id);
      const failed = [...this.jobs.values()].filter(entry => ["failed", "cancelled"].includes(entry.status));
      for (const old of failed.slice(0, Math.max(0, failed.length - 50))) this.jobs.delete(old.id);
    }
  }

  async cleanupSources(id) {
    const work = this.work.get(id);
    if (!work) return;
    this.work.delete(id);
    await Promise.all([...work.images.map(image => clean(image.path)), clean(work.workDir)]);
  }
  async delete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.controllers.get(id)?.abort();
    this.jobs.delete(id);
    this.queue = this.queue.filter(entry => entry !== id);
    const task = this.tasks.get(id);
    if (task) await Promise.allSettled([task]);
    await Promise.all([clean(this.filePath(id)), clean(this.partialPath(id)), clean(this.metadataPath(id)), clean(`${this.metadataPath(id)}.tmp`), this.cleanupSources(id)]);
    return true;
  }
  async prune() {
    const completed = [...this.jobs.values()].filter(job => job.status === "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const job of completed.slice(this.maxCompleted)) {
      this.jobs.delete(job.id);
      await Promise.all([clean(this.filePath(job.id)), clean(this.metadataPath(job.id))]);
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks.values()]);
    for (const id of this.work.keys()) await this.cleanupSources(id);
  }
}
