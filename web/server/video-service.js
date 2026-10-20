import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  copyFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  FORMATS,
  inspectImage,
  renderSequence,
  RenderError,
} from "./renderer.js";
import {
  MAX_IMAGES,
  MAX_TOTAL_DURATION,
  resolvePromptMotion,
} from "../shared/prompt.js";

const ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const clean = (file) =>
  rm(file, { force: true, recursive: true }).catch(() => {});

export class VideoService {
  constructor({
    dataDir,
    ffmpegPath = "ffmpeg",
    ffprobePath = "ffprobe",
    maxPending = 5,
    maxCompleted = 50,
  }) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, "uploads");
    this.videoDir = path.join(dataDir, "videos");
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.maxPending = maxPending;
    this.maxCompleted = maxCompleted;
    this.jobs = new Map();
    this.queue = [];
    this.reservations = 0;
    this.current = null;
    this.closed = false;
    this.controllers = new Map();
    this.tasks = new Set();
  }

  async init() {
    await Promise.all([
      mkdir(this.uploadDir, { recursive: true }),
      mkdir(this.videoDir, { recursive: true }),
    ]);
    for (const entry of await readdir(this.uploadDir))
      await clean(path.join(this.uploadDir, entry));
    for (const entry of await readdir(this.videoDir)) {
      if (entry.endsWith(".partial.mp4") || entry.endsWith(".json.tmp"))
        await clean(path.join(this.videoDir, entry));
      if (!entry.endsWith(".json")) continue;
      try {
        const job = JSON.parse(
          await readFile(path.join(this.videoDir, entry), "utf8"),
        );
        if (
          !ID_PATTERN.test(job.id) ||
          entry !== `${job.id}.json` ||
          job.status !== "completed"
        )
          continue;
        if (!(await stat(this.filePath(job.id))).isFile()) continue;
        this.jobs.set(job.id, job);
      } catch {
        /* Skip incomplete or damaged metadata; it cannot become an API path. */
      }
    }
    // A crash between publishing an MP4 and its metadata must not leak disk space forever.
    for (const entry of await readdir(this.videoDir)) {
      if (
        entry.endsWith(".mp4") &&
        ID_PATTERN.test(entry.slice(0, -4)) &&
        !this.jobs.has(entry.slice(0, -4))
      ) {
        await clean(path.join(this.videoDir, entry));
      }
    }
    await this.prune();
  }

  filePath(id) {
    return path.join(this.videoDir, `${id}.mp4`);
  }
  partialPath(id) {
    return path.join(this.videoDir, `${id}.partial.mp4`);
  }
  metadataPath(id) {
    return path.join(this.videoDir, `${id}.json`);
  }
  pendingCount() {
    return (
      this.reservations +
      [...this.jobs.values()].filter((job) =>
        ["queued", "processing"].includes(job.status),
      ).length
    );
  }
  reserve() {
    if (this.closed)
      throw new RenderError(
        "The video service is restarting. Try again shortly.",
        503,
      );
    if (this.pendingCount() >= this.maxPending)
      throw new RenderError(
        "The render queue is full. Wait for a video to finish, then try again.",
        429,
      );
    this.reservations += 1;
    let released = false;
    return () => {
      if (!released) {
        this.reservations -= 1;
        released = true;
      }
    };
  }

  publicJob(job) {
    const { imagePath, demuxer, images, workDir, parentPath, ...publicFields } =
      job;
    return {
      ...publicFields,
      fileUrl: job.status === "completed" ? `/api/videos/${job.id}/file` : null,
    };
  }
  get(id) {
    return this.jobs.get(id);
  }
  list() {
    return [...this.jobs.values()]
      .filter((job) => job.status === "completed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.publicJob(job));
  }

  async enqueue(
    files,
    { motion, duration, format, prompt = "", parentId = null },
    signal,
  ) {
    const parent = parentId ? this.jobs.get(parentId) : null;
    if (parentId && (!parent || parent.status !== "completed"))
      throw new RenderError("Choose a completed video to extend.", 404);
    if (files.length > MAX_IMAGES || (!files.length && !parent))
      throw new RenderError(`Choose between 1 and ${MAX_IMAGES} images.`, 400);
    const totalDuration = (parent?.duration || 0) + duration;
    if (totalDuration > MAX_TOTAL_DURATION)
      throw new RenderError(
        `A video can be at most ${MAX_TOTAL_DURATION} seconds long. Choose a shorter extension.`,
        400,
      );
    const id = randomUUID();
    const workDir = await mkdtemp(path.join(this.uploadDir, `${id}-`));
    let parentPath = null;
    const images = [];
    try {
      if (parent) {
        parentPath = path.join(workDir, "parent.mp4");
        try {
          await copyFile(this.filePath(parent.id), parentPath);
        } catch (error) {
          if (error.code === "ENOENT")
            throw new RenderError(
              "The original video is no longer available. Choose another completed video.",
              404,
            );
          throw error;
        }
        format = parent.format;
      }
      for (const file of files) {
        const image = await inspectImage(file.path, {
          ffprobePath: this.ffprobePath,
          signal,
        });
        images.push({ imagePath: file.path, demuxer: image.demuxer });
      }
      if (signal?.aborted || this.closed)
        throw new RenderError("Generation cancelled.", 499);
    } catch (error) {
      await clean(workDir);
      throw error;
    }
    const job = {
      id,
      status: "queued",
      progress: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      motion: resolvePromptMotion(prompt, motion),
      prompt,
      parentId: parent?.id || null,
      duration: totalDuration,
      addedDuration: duration,
      imageCount: files.length || 1,
      format,
      ...FORMATS[format],
      filename: `vanta-${id.slice(0, 8)}.mp4`,
      error: null,
      images,
      workDir,
      parentPath,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    // Let the POST response finish before starting CPU work.
    setImmediate(() => this.pump());
    return job;
  }

  pump() {
    if (this.current || this.closed) return;
    let job;
    while (this.queue.length && !job) job = this.jobs.get(this.queue.shift());
    if (!job) return;
    this.current = job.id;
    const task = this.run(job).finally(() => {
      this.tasks.delete(task);
      this.current = null;
      this.pump();
    });
    this.tasks.add(task);
  }

  async run(job) {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    job.status = "processing";
    job.progress = 1;
    try {
      await renderSequence(
        { ...job, outputPath: this.partialPath(job.id) },
        {
          ffmpegPath: this.ffmpegPath,
          ffprobePath: this.ffprobePath,
          signal: controller.signal,
          onProgress: (microseconds) => {
            job.progress = Math.min(
              99,
              Math.max(
                job.progress,
                Math.round(microseconds / (job.addedDuration * 10_000)),
              ),
            );
          },
        },
      );
      if (controller.signal.aborted)
        throw new RenderError("Generation cancelled.", 499);
      await rename(this.partialPath(job.id), this.filePath(job.id));
      job.status = "completed";
      job.progress = 100;
      job.completedAt = new Date().toISOString();
      const temporary = `${this.metadataPath(job.id)}.tmp`;
      await writeFile(temporary, JSON.stringify(this.publicJob(job), null, 2), {
        mode: 0o600,
      });
      await rename(temporary, this.metadataPath(job.id));
      await this.prune();
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.error =
        error instanceof RenderError
          ? error.message
          : "Video generation failed. Please try again.";
      await Promise.all([
        clean(this.partialPath(job.id)),
        clean(this.filePath(job.id)),
        clean(`${this.metadataPath(job.id)}.tmp`),
      ]);
    } finally {
      this.controllers.delete(job.id);
      await this.cleanupSources(job);
      // Avoid retaining an unbounded number of failed jobs in a long-running server.
      const unsuccessful = [...this.jobs.values()].filter((entry) =>
        ["failed", "cancelled"].includes(entry.status),
      );
      for (const old of unsuccessful.slice(
        0,
        Math.max(0, unsuccessful.length - 50),
      ))
        this.jobs.delete(old.id);
    }
  }

  async delete(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.controllers.get(id)?.abort();
    this.jobs.delete(id);
    this.queue = this.queue.filter((entry) => entry !== id);
    // Wait for a running render before removing its files, avoiding a completed-file race.
    if (this.current === id) await Promise.allSettled([...this.tasks]);
    await Promise.all([
      clean(this.filePath(id)),
      clean(this.partialPath(id)),
      clean(this.metadataPath(id)),
      clean(`${this.metadataPath(id)}.tmp`),
      this.cleanupSources(job),
    ]);
    return true;
  }

  async prune() {
    const completed = [...this.jobs.values()]
      .filter((job) => job.status === "completed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const job of completed.slice(this.maxCompleted)) {
      this.jobs.delete(job.id);
      await Promise.all([
        clean(this.filePath(job.id)),
        clean(this.metadataPath(job.id)),
      ]);
    }
  }

  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
    for (const job of this.jobs.values()) await this.cleanupSources(job);
  }

  async cleanupSources(job) {
    await Promise.all([
      ...(job.images || []).map((image) => clean(image.imagePath)),
      ...(job.workDir ? [clean(job.workDir)] : []),
    ]);
    delete job.images;
    delete job.workDir;
    delete job.parentPath;
  }
}
