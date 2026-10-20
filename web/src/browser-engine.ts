import { ApiError } from "./runtime";
import {
  MAX_IMAGES,
  MAX_PROMPT_LENGTH,
  MAX_TOTAL_DURATION,
  resolvePromptMotion,
} from "../shared/prompt.js";

type Motion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "still";
type Format = "landscape" | "portrait" | "square";
type Job = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  duration: number;
  addedDuration: number;
  parentId: string | null;
  prompt: string;
  imageCount: number;
  format: Format;
  motion: Motion;
  width: number;
  height: number;
  createdAt: string;
  completedAt: string | null;
  fileUrl: string | null;
  error: string | null;
  filename: string;
  mimeType: string;
  extension: string;
  persisted: boolean;
  warning: string | null;
};
type StoredVideo = { id: string; job: Job; blob: Blob };
type Work = {
  files: File[];
  parentBlob?: Blob;
  parentDuration: number;
  job: Job;
  controller: AbortController;
  running?: Promise<void>;
};
const sizes = {
  landscape: [1280, 720],
  portrait: [720, 1280],
  square: [720, 720],
} as const;
const motions = ["zoom-in", "zoom-out", "pan-left", "pan-right", "still"];
const jobs = new Map<string, Job>();
const completedBlobs = new Map<string, Blob>();
const work = new Map<string, Work>();
const queue: string[] = [];
let busy = false;
let reservations = 0;
let database: IDBDatabase | undefined;
let storageWarning: string | null = null;
let initialization: Promise<void> | undefined;
const storageMessage =
  "Browser storage is unavailable or full. Download your video now; it will not be kept after this page closes.";

function createId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!database) return reject(new Error(storageMessage));
    let tx: IDBTransaction;
    try {
      tx = database.transaction("videos", mode);
    } catch {
      return reject(new Error(storageMessage));
    }
    const timer = window.setTimeout(() => {
      try {
        tx.abort();
      } catch {
        /* already completed */
      }
      reject(new Error(storageMessage));
    }, 5000);
    const finish = () => window.clearTimeout(timer);
    let request: IDBRequest<T>;
    try {
      request = operation(tx.objectStore("videos"));
    } catch {
      finish();
      reject(new Error(storageMessage));
      return;
    }
    tx.oncomplete = () => {
      finish();
      resolve(request.result);
    };
    tx.onabort = tx.onerror = () => {
      finish();
      reject(new Error(storageMessage));
    };
  });
}

async function initialize() {
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        settled = true;
        reject(new Error(storageMessage));
      }, 3000);
      const request = indexedDB.open("vanta-motion-studio", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("videos"))
          request.result.createObjectStore("videos", { keyPath: "id" });
      };
      request.onsuccess = () => {
        window.clearTimeout(timer);
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
      request.onerror = request.onblocked = () => {
        window.clearTimeout(timer);
        settled = true;
        reject(new Error(storageMessage));
      };
    });
    database.onversionchange = () => {
      database?.close();
      database = undefined;
      storageWarning = storageMessage;
    };
    const records = await transaction<StoredVideo[]>("readonly", (store) =>
      store.getAll(),
    );
    for (const record of records) {
      if (
        !(record.blob instanceof Blob) ||
        !record.blob.size ||
        record.job?.status !== "completed" ||
        record.id !== record.job.id ||
        !["mp4", "webm"].includes(record.job.extension)
      )
        continue;
      completedBlobs.set(record.id, record.blob);
      jobs.set(record.id, {
        ...record.job,
        parentId: record.job.parentId ?? null,
        prompt: record.job.prompt ?? "",
        addedDuration: record.job.addedDuration ?? record.job.duration,
        imageCount: record.job.imageCount ?? 1,
        fileUrl: URL.createObjectURL(record.blob),
        persisted: true,
        warning: null,
      });
    }
  } catch {
    storageWarning = storageMessage;
  }
}

function recorderType() {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof HTMLCanvasElement.prototype.captureStream !== "function"
  ) {
    throw new ApiError(
      "This browser cannot record video. Open this file in a current Chrome, Edge, Firefox, or Safari browser.",
      503,
    );
  }
  const mimeType = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType)
    throw new ApiError(
      "This browser has no supported video encoder. Try a current Chrome, Edge, Firefox, or Safari browser.",
      503,
    );
  return {
    mimeType,
    extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
  };
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new ApiError("Video generation cancelled.", 499);
}

function checkVisible(signal: AbortSignal) {
  checkCancelled(signal);
  if (document.hidden)
    throw new ApiError(
      "Keep this page visible while your video renders, then try again.",
      400,
    );
}

function loadParent(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", loaded);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", visibility);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => finish();
    const failed = () =>
      finish(
        new ApiError(
          "The saved video cannot be decoded for extension. Try generating it again.",
          400,
        ),
      );
    const abort = () =>
      finish(new ApiError("Video generation cancelled.", 499));
    const visibility = () => {
      if (document.hidden)
        finish(
          new ApiError(
            "Keep this page visible while your video renders, then try again.",
            400,
          ),
        );
    };
    const timer = window.setTimeout(failed, 8000);
    video.addEventListener("loadeddata", loaded, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", visibility);
    if (signal.aborted) abort();
    else if (document.hidden) visibility();
    else if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) loaded();
    else video.load();
  });
}

async function record({
  files,
  parentBlob,
  parentDuration,
  job,
  controller,
}: Work): Promise<Blob> {
  const { signal } = controller;
  checkVisible(signal);
  const images: ImageBitmap[] = [];
  let stream: MediaStream | undefined;
  let parentVideo: HTMLVideoElement | undefined;
  let parentUrl: string | undefined;
  let continuation: HTMLCanvasElement | undefined;
  const canvas = document.createElement("canvas");
  canvas.width = job.width;
  canvas.height = job.height;
  try {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context)
      throw new ApiError(
        "The browser could not create a video canvas. Close other tabs and try again.",
        503,
      );
    const aspect = job.width / job.height;
    // Decode one original at a time; retain only small output-sized bitmaps.
    // Six large uploads must not keep six full-resolution decodes in memory.
    for (const file of files) {
      checkVisible(signal);
      let original: ImageBitmap;
      try {
        original = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
      } catch {
        throw new ApiError(
          "An image cannot be decoded. Try another JPEG, PNG, or WebP image.",
          400,
        );
      }
      const scaled = document.createElement("canvas");
      try {
        checkVisible(signal);
        if (
          original.width < 2 ||
          original.height < 2 ||
          Math.max(original.width, original.height) > 16384 ||
          original.width * original.height > 40_000_000
        )
          throw new ApiError(
            "Use images between 2 and 16,384 pixels per side, up to 40 megapixels each.",
            400,
          );
        scaled.width = Math.ceil(job.width * 1.16);
        scaled.height = Math.ceil(job.height * 1.16);
        const scaledContext = scaled.getContext("2d", { alpha: false });
        if (!scaledContext)
          throw new ApiError(
            "The browser could not prepare your images. Close other tabs and try again.",
            503,
          );
        const width = Math.min(original.width, original.height * aspect);
        const height = width / aspect;
        scaledContext.drawImage(
          original,
          (original.width - width) / 2,
          (original.height - height) / 2,
          width,
          height,
          0,
          0,
          scaled.width,
          scaled.height,
        );
        images.push(await createImageBitmap(scaled));
      } finally {
        original.close();
        scaled.width = scaled.height = 0;
      }
    }
    checkVisible(signal);
    if (parentBlob) {
      parentUrl = URL.createObjectURL(parentBlob);
      parentVideo = document.createElement("video");
      parentVideo.preload = "auto";
      parentVideo.muted = true;
      parentVideo.playsInline = true;
      parentVideo.src = parentUrl;
      await loadParent(parentVideo, signal);
      checkVisible(signal);
      context.drawImage(parentVideo, 0, 0, canvas.width, canvas.height);
    }
    const draw = (source: ImageBitmap | HTMLCanvasElement, t: number) => {
      const baseWidth = Math.min(source.width, source.height * aspect);
      const baseHeight = baseWidth / aspect;
      const zoom =
        job.motion === "zoom-in"
          ? 1 + 0.16 * t
          : job.motion === "zoom-out"
            ? 1.16 - 0.16 * t
            : job.motion.startsWith("pan-")
              ? 1.16
              : 1;
      const width = baseWidth / zoom;
      const height = baseHeight / zoom;
      const position =
        job.motion === "pan-left"
          ? 1 - t
          : job.motion === "pan-right"
            ? t
            : 0.5;
      context.drawImage(
        source,
        (source.width - baseWidth) / 2 + (baseWidth - width) * position,
        (source.height - height) / 2,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    if (!parentVideo) draw(images[0], 0);
    stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, {
      mimeType: job.mimeType,
      videoBitsPerSecond: 4_000_000,
    });
    job.mimeType = recorder.mimeType || job.mimeType;
    return await new Promise<Blob>((resolve, reject) => {
      const chunks: BlobPart[] = [];
      let frame = 0;
      let stopTimer = 0;
      let appendedAt = 0;
      let playingParent = Boolean(parentVideo);
      let settled = false;
      const cleanup = () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(stopTimer);
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        document.removeEventListener("visibilitychange", visibility);
        parentVideo?.removeEventListener("ended", parentEnded);
        parentVideo?.removeEventListener("error", parentFailed);
        parentVideo?.pause();
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.onstart = null;
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            /* already stopped */
          }
        }
        reject(error);
      };
      const abort = () =>
        fail(new ApiError("Video generation cancelled.", 499));
      const visibility = () => {
        if (document.hidden)
          fail(
            new ApiError(
              "Rendering stopped because this page was hidden. Keep it visible and try again.",
              400,
            ),
          );
      };
      const parentFailed = () =>
        fail(
          new ApiError(
            "The saved video could not be played for extension. Try generating it again.",
            400,
          ),
        );
      const parentEnded = () => {
        if (settled || !playingParent || !parentVideo) return;
        try {
          // Preserve every parent scene, then use its actual final frame if no
          // new images were supplied. No original uploads need to be retained.
          if (!images.length) {
            continuation = document.createElement("canvas");
            continuation.width = job.width;
            continuation.height = job.height;
            const finalContext = continuation.getContext("2d", {
              alpha: false,
            });
            if (!finalContext) throw new Error("Canvas unavailable");
            finalContext.drawImage(parentVideo, 0, 0, job.width, job.height);
          }
          playingParent = false;
          appendedAt = performance.now();
          parentVideo.pause();
        } catch {
          fail(
            new ApiError(
              "The final video frame could not be prepared for extension. Try adding new images.",
              400,
            ),
          );
        }
      };
      const timeout = window.setTimeout(
        () =>
          fail(
            new ApiError(
              "The browser video encoder stopped responding. Try again with other tabs closed.",
              503,
            ),
          ),
        job.duration * 1000 + 12000,
      );
      const tick = (now: number) => {
        if (settled) return;
        let elapsed = 0;
        let complete = false;
        try {
          if (playingParent && parentVideo) {
            context.drawImage(parentVideo, 0, 0, canvas.width, canvas.height);
            elapsed = Math.min(parentDuration, parentVideo.currentTime);
            if (parentVideo.ended) parentEnded();
          } else {
            const t = Math.min(
              1,
              Math.max(0, (now - appendedAt) / (job.addedDuration * 1000)),
            );
            const count = images.length || 1;
            const index = Math.min(count - 1, Math.floor(t * count));
            const source = images[index] ?? continuation;
            if (!source) throw new Error("Missing video scene");
            draw(source, Math.min(1, t * count - index));
            elapsed = parentDuration + t * job.addedDuration;
            complete = t >= 1;
          }
        } catch {
          fail(
            new ApiError(
              "A video scene could not be rendered. Try another image.",
              400,
            ),
          );
          return;
        }
        if (settled) return;
        job.progress = Math.max(
          job.progress,
          Math.min(98, Math.round((elapsed / job.duration) * 98)),
        );
        if (!complete) frame = window.requestAnimationFrame(tick);
        else
          stopTimer = window.setTimeout(() => {
            if (!settled && recorder.state === "recording") recorder.stop();
          }, 50);
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () =>
        fail(
          new ApiError(
            "The browser video encoder failed. Try another browser or close other tabs.",
            503,
          ),
        );
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const blob = new Blob(chunks, { type: job.mimeType });
        if (blob.size) resolve(blob);
        else
          reject(
            new ApiError(
              "The browser produced an empty video. Please try again.",
              503,
            ),
          );
      };
      recorder.onstart = () => {
        appendedAt = performance.now();
        if (parentVideo) {
          parentVideo.addEventListener("ended", parentEnded, { once: true });
          parentVideo.addEventListener("error", parentFailed, { once: true });
          parentVideo
            .play()
            .then(() => {
              if (settled) parentVideo?.pause();
            })
            .catch(parentFailed);
        }
        frame = window.requestAnimationFrame(tick);
      };
      signal.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", visibility);
      if (signal.aborted) abort();
      else if (document.hidden) visibility();
      else {
        try {
          recorder.start(250);
        } catch {
          fail(
            new ApiError(
              "Unable to start the browser video encoder. Try another browser.",
              503,
            ),
          );
        }
      }
    });
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    images.forEach((image) => image.close());
    if (parentVideo) {
      parentVideo.pause();
      parentVideo.removeAttribute("src");
      parentVideo.load();
    }
    if (parentUrl) URL.revokeObjectURL(parentUrl);
    if (continuation) continuation.width = continuation.height = 0;
    canvas.width = canvas.height = 0;
  }
}

function pump() {
  if (busy) return;
  const id = queue.shift();
  if (!id) return;
  const entry = work.get(id);
  if (!entry) {
    pump();
    return;
  }
  busy = true;
  entry.job.status = "processing";
  entry.job.progress = 1;
  entry.running = (async () => {
    try {
      const blob = await record(entry);
      checkCancelled(entry.controller.signal);
      entry.job.fileUrl = URL.createObjectURL(blob);
      entry.job.progress = 99;
      entry.job.completedAt = new Date().toISOString();
      try {
        await transaction("readwrite", (store) =>
          store.put({
            id,
            job: {
              ...entry.job,
              status: "completed",
              progress: 100,
              fileUrl: null,
              persisted: true,
            },
            blob,
          }),
        );
        entry.job.persisted = true;
      } catch {
        storageWarning = storageMessage;
        entry.job.warning = storageMessage;
      }
      checkCancelled(entry.controller.signal);
      completedBlobs.set(id, blob);
      entry.job.status = "completed";
      entry.job.progress = 100;
    } catch (error) {
      completedBlobs.delete(id);
      if (entry.job.fileUrl) {
        URL.revokeObjectURL(entry.job.fileUrl);
        entry.job.fileUrl = null;
      }
      entry.job.status = entry.controller.signal.aborted
        ? "cancelled"
        : "failed";
      entry.job.error =
        error instanceof Error
          ? error.message
          : "Video generation failed. Please try again.";
    } finally {
      work.delete(id);
      busy = false;
      pump();
    }
  })();
}

export async function browserRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  await (initialization ??= initialize());
  const method = (options.method || "GET").toUpperCase();
  if (options.signal?.aborted) throw new ApiError("Request cancelled.", 499);
  if (method === "GET" && path === "/api/health") {
    recorderType();
    return { status: "ok", mode: "browser" } as T;
  }
  if (method === "GET" && path === "/api/capabilities") {
    const encoding = recorderType();
    return {
      local: true,
      ai: false,
      mode: "browser",
      ...encoding,
      storage: storageWarning ? "session" : "persistent",
      storageWarning,
      maxImages: MAX_IMAGES,
      maxTotalDuration: MAX_TOTAL_DURATION,
      maxPromptLength: MAX_PROMPT_LENGTH,
    } as T;
  }
  if (method === "GET" && path === "/api/videos") {
    return {
      videos: [...jobs.values()]
        .filter((job) => job.status === "completed")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((job) => ({ ...job })),
    } as T;
  }
  if (method === "POST" && path === "/api/videos") {
    if (work.size + reservations >= 5)
      throw new ApiError(
        "The render queue is full. Wait for a video to finish, then try again.",
        429,
      );
    const form = options.body;
    if (!(form instanceof FormData))
      throw new ApiError("Upload an image and video settings.", 400);
    const parentId = form.get("parentId") || null;
    if (parentId !== null && typeof parentId !== "string")
      throw new ApiError("Choose a completed video to extend.", 400);
    const parent = parentId ? jobs.get(parentId) : undefined;
    const parentBlob = parentId ? completedBlobs.get(parentId) : undefined;
    if (parentId && (!parent || parent.status !== "completed" || !parentBlob))
      throw new ApiError(
        "The original video is unavailable. Choose a completed video from your library.",
        404,
      );
    const uploads = form.getAll("image");
    if ((!parent && uploads.length < 1) || uploads.length > MAX_IMAGES)
      throw new ApiError(
        `Choose between 1 and ${MAX_IMAGES} images, or extend a video without new images.`,
        400,
      );
    const files: File[] = [];
    let uploadSize = 0;
    for (const file of uploads) {
      if (
        !(file instanceof File) ||
        !["image/jpeg", "image/png", "image/webp"].includes(file.type)
      )
        throw new ApiError("Choose JPEG, PNG, or WebP images.", 400);
      if (!file.size || file.size > 20 * 1024 * 1024)
        throw new ApiError(
          "Each image must be nonempty and no larger than 20 MB.",
          413,
        );
      uploadSize += file.size;
      files.push(file);
    }
    if (uploadSize > 60 * 1024 * 1024)
      throw new ApiError(
        "The selected images exceed the 60 MB total upload limit.",
        413,
      );
    const rawPrompt = form.get("prompt") ?? "";
    if (typeof rawPrompt !== "string" || rawPrompt.length > MAX_PROMPT_LENGTH)
      throw new ApiError(
        `Keep your prompt within ${MAX_PROMPT_LENGTH} characters.`,
        400,
      );
    const prompt = rawPrompt.trim();
    const motion = form.get("motion") ?? "zoom-in",
      format = form.get("format") ?? "landscape",
      duration = form.get("duration") ?? "5";
    if (
      typeof motion !== "string" ||
      !motions.includes(motion) ||
      (!parent &&
        (typeof format !== "string" || !Object.hasOwn(sizes, format))) ||
      typeof duration !== "string" ||
      !["3", "5", "10"].includes(duration)
    )
      throw new ApiError(
        "Choose a supported motion, format, and duration.",
        400,
      );
    const addedDuration = Number(duration);
    const parentDuration = parent?.duration ?? 0;
    if (parentDuration + addedDuration > MAX_TOTAL_DURATION)
      throw new ApiError(
        `An extended video can be at most ${MAX_TOTAL_DURATION} seconds. Choose a shorter extension.`,
        400,
      );
    const encoding = recorderType();
    reservations += 1;
    try {
      for (const file of files) {
        const magic = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
          (value, index) => magic[index] === value,
        );
        const jpeg = magic[0] === 255 && magic[1] === 216 && magic[2] === 255;
        const webp =
          new TextDecoder().decode(magic.slice(0, 4)) === "RIFF" &&
          new TextDecoder().decode(magic.slice(8)) === "WEBP";
        if (!png && !jpeg && !webp)
          throw new ApiError("Choose valid JPEG, PNG, or WebP images.", 400);
      }
      if (options.signal?.aborted)
        throw new ApiError("Request cancelled.", 499);
      const id = createId(),
        [width, height] = parent
          ? [parent.width, parent.height]
          : sizes[format as Format];
      const job: Job = {
        id,
        status: "queued",
        progress: 0,
        duration: parentDuration + addedDuration,
        addedDuration,
        parentId,
        prompt,
        imageCount: files.length || 1,
        format: parent?.format ?? (format as Format),
        motion: resolvePromptMotion(prompt, motion as Motion),
        width,
        height,
        createdAt: new Date().toISOString(),
        completedAt: null,
        fileUrl: null,
        error: null,
        ...encoding,
        filename: `vanta-${id.slice(0, 8)}.${encoding.extension}`,
        persisted: false,
        warning: storageWarning,
      };
      jobs.set(id, job);
      work.set(id, {
        files,
        parentBlob,
        parentDuration,
        job,
        controller: new AbortController(),
      });
      queue.push(id);
      window.setTimeout(pump, 0);
      return { ...job } as T;
    } finally {
      reservations -= 1;
    }
  }
  const match = /^\/api\/videos\/([^/]+)$/.exec(path),
    job = match ? jobs.get(match[1]) : undefined;
  if (!job) throw new ApiError("Video not found.", 404);
  if (method === "GET") return { ...job } as T;
  if (method === "DELETE") {
    if (job.persisted && !database)
      throw new ApiError(
        "Browser storage was disconnected. Reload this page to reconnect, then delete the saved video again.",
        503,
      );
    const entry = work.get(job.id);
    entry?.controller.abort();
    jobs.delete(job.id);
    completedBlobs.delete(job.id);
    const queued = queue.indexOf(job.id);
    if (queued >= 0) queue.splice(queued, 1);
    if (entry?.running) await entry.running;
    work.delete(job.id);
    if (job.fileUrl) URL.revokeObjectURL(job.fileUrl);
    if (database) {
      try {
        await transaction("readwrite", (store) => store.delete(job.id));
      } catch {
        throw new ApiError(
          "The video was removed from this page, but browser storage could not be updated. It may reappear after reloading.",
          500,
        );
      }
    }
    return undefined as T;
  }
  throw new ApiError("API route not found.", 404);
}
