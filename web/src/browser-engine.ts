import { ApiError } from "./runtime";

type Motion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "still";
type Format = "landscape" | "portrait" | "square";
type Job = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  duration: number;
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
  file: File;
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
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
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
      jobs.set(record.id, {
        ...record.job,
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

async function record({ file, job, controller }: Work): Promise<Blob> {
  const { signal } = controller;
  checkCancelled(signal);
  if (document.hidden)
    throw new ApiError(
      "Keep this page visible while your video renders, then try again.",
      400,
    );
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new ApiError(
      "This image cannot be decoded. Try another JPEG, PNG, or WebP image.",
      400,
    );
  }
  let stream: MediaStream | undefined;
  try {
    checkCancelled(signal);
    if (document.hidden)
      throw new ApiError(
        "Keep this page visible while your video renders, then try again.",
        400,
      );
    if (
      image.width < 2 ||
      image.height < 2 ||
      Math.max(image.width, image.height) > 16384 ||
      image.width * image.height > 40_000_000
    ) {
      throw new ApiError(
        "Use an image between 2 and 16,384 pixels per side, up to 40 megapixels.",
        400,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = job.width;
    canvas.height = job.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context)
      throw new ApiError(
        "The browser could not create a video canvas. Close other tabs and try again.",
        503,
      );
    const aspect = job.width / job.height;
    const baseWidth = Math.min(image.width, image.height * aspect),
      baseHeight = baseWidth / aspect;
    const draw = (t: number) => {
      const zoom =
        job.motion === "zoom-in"
          ? 1 + 0.16 * t
          : job.motion === "zoom-out"
            ? 1.16 - 0.16 * t
            : job.motion.startsWith("pan-")
              ? 1.16
              : 1;
      const width = baseWidth / zoom,
        height = baseHeight / zoom;
      const position =
        job.motion === "pan-left"
          ? 1 - t
          : job.motion === "pan-right"
            ? t
            : 0.5;
      const x = (image.width - baseWidth) / 2 + (baseWidth - width) * position;
      const y = (image.height - height) / 2;
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        x,
        y,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    };
    draw(0);
    stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, {
      mimeType: job.mimeType,
      videoBitsPerSecond: 4_000_000,
    });
    job.mimeType = recorder.mimeType || job.mimeType;
    return await new Promise<Blob>((resolve, reject) => {
      const chunks: BlobPart[] = [];
      let frame = 0,
        stopTimer = 0,
        started = 0,
        settled = false;
      const cleanup = () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(stopTimer);
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        document.removeEventListener("visibilitychange", visibility);
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
      const timeout = window.setTimeout(
        () =>
          fail(
            new ApiError(
              "The browser video encoder stopped responding. Try again with other tabs closed.",
              503,
            ),
          ),
        job.duration * 1000 + 8000,
      );
      const tick = (now: number) => {
        if (settled) return;
        const t = Math.min(
          1,
          Math.max(0, (now - started) / (job.duration * 1000)),
        );
        try {
          draw(t);
        } catch {
          fail(
            new ApiError(
              "The image could not be rendered. Try another image.",
              400,
            ),
          );
          return;
        }
        job.progress = Math.max(job.progress, Math.min(98, Math.round(t * 98)));
        if (t < 1) frame = window.requestAnimationFrame(tick);
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
        started = performance.now();
        frame = window.requestAnimationFrame(tick);
      };
      signal.addEventListener("abort", abort, { once: true });
      document.addEventListener("visibilitychange", visibility);
      if (signal.aborted) abort();
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
    image.close();
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
      entry.job.status = "completed";
      entry.job.progress = 100;
    } catch (error) {
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
    const file = form.get("image");
    if (
      !(file instanceof File) ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    )
      throw new ApiError("Choose a JPEG, PNG, or WebP image.", 400);
    if (file.size > 20 * 1024 * 1024)
      throw new ApiError("Image is too large. Maximum size is 20 MB.", 413);
    const motion = form.get("motion") ?? "zoom-in",
      format = form.get("format") ?? "landscape",
      duration = form.get("duration") ?? "5";
    if (
      typeof motion !== "string" ||
      !motions.includes(motion) ||
      typeof format !== "string" ||
      !Object.hasOwn(sizes, format) ||
      typeof duration !== "string" ||
      !["3", "5", "10"].includes(duration)
    )
      throw new ApiError(
        "Choose a supported motion, format, and duration.",
        400,
      );
    const encoding = recorderType();
    reservations += 1;
    try {
      const magic = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
        (value, index) => magic[index] === value,
      );
      const jpeg = magic[0] === 255 && magic[1] === 216 && magic[2] === 255;
      const webp =
        new TextDecoder().decode(magic.slice(0, 4)) === "RIFF" &&
        new TextDecoder().decode(magic.slice(8)) === "WEBP";
      if (!png && !jpeg && !webp)
        throw new ApiError("Choose a valid JPEG, PNG, or WebP image.", 400);
      if (options.signal?.aborted)
        throw new ApiError("Request cancelled.", 499);
      const id = createId(),
        [width, height] = sizes[format as Format];
      const job: Job = {
        id,
        status: "queued",
        progress: 0,
        duration: Number(duration),
        format: format as Format,
        motion: motion as Motion,
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
      work.set(id, { file, job, controller: new AbortController() });
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
