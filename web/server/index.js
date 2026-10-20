import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMATS, MOTIONS, RenderError } from "./renderer.js";
import { VideoService } from "./video-service.js";
import { LocalWanService } from "./local-wan-service.js";
import { MAX_IMAGES, MAX_PROMPT_LENGTH } from "../shared/prompt.js";

const webDir = fileURLToPath(new URL("..", import.meta.url));

export async function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const service = new VideoService({
    dataDir: path.join(webDir, ".data"),
    ffmpegPath,
    ffprobePath,
    ...options,
  });
  await service.init();
  app.locals.videoService = service;
  // VANTA Motion Core: one local engine, no cloud provider and no LTX.
  const wanService = new LocalWanService({
    dataDir: options.dataDir ?? path.join(webDir, ".data"),
    ffmpegPath,
    ffprobePath,
  });
  await wanService.init();
  app.locals.aiService = wanService;
  app.locals.wanService = wanService;

  const sourceFor = (id) =>
    wanService.get(id) ? wanService : service.get(id) ? service : service;
  const upload = multer({
    storage: multer.diskStorage({
      destination: service.uploadDir,
      filename: (_req, _file, callback) =>
        callback(null, `${randomUUID()}.image`),
    }),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: MAX_IMAGES,
      fields: 12,
      parts: 24,
      fieldSize: 4096,
    },
    fileFilter: (_req, file, callback) => {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
        return callback(
          new RenderError("Choose a JPEG, PNG, or WebP image.", 400),
        );
      }
      callback(null, true);
    },
  }).array("image", MAX_IMAGES);

  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", mode: "local" }),
  );
  app.get("/api/capabilities", (_req, res) =>
    res.json({
      local: true,
      ai: wanService.configured,
      referenceAi: false,
      xzakutMotion: wanService.configured,
      vantaMotion: wanService.configured,
      referenceCore: "training",
      aiNeedsKey: false,
      aiNeedsLocalModel: !wanService.configured,
      aiMaxImages: 0,
      aiModel: wanService.configured
        ? "VANTA Motion Core · XZAKUT trained Wan"
        : null,
      outputResolution: "1080p",
      aiSourceResolution: "480x832 / 832x480",
      aiUpscaled: true,
    }),
  );
  app.get("/api/videos", (_req, res) =>
    res.json({
      videos: [...service.list(), ...wanService.list()].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );

  app.post("/api/videos", async (req, res, next) => {
    let release;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    try {
      await new Promise((resolve, reject) =>
        upload(req, res, (error) => (error ? reject(error) : resolve())),
      );
      const {
        motion = "zoom-in",
        duration = "5",
        format = "landscape",
        prompt = "",
        parentId = null,
        engine = "camera",
        backgroundIndex = "0",
        keepIdentity = "true",
        keepOutfit = "true",
        aiBackend = "vanta-motion",
        soundMode = "silent",
      } = req.body;
      if (!["ai", "camera"].includes(engine))
        throw new RenderError("Choose AI scene or Camera sequence.", 400);
      if (engine === "camera") release = service.reserve();
      const files = req.files || [];
      const promptOnlyWan = engine === "ai";
      if (!files.length && !parentId && !promptOnlyWan)
        throw new RenderError(
          "Upload at least one image to generate a video.",
          400,
        );
      if (promptOnlyWan && files.length)
        throw new RenderError(
          "VANTA Motion Core is prompt-only while VANTA Reference Core is being trained. Remove reference images for this render.",
          400,
        );
      if (
        files.reduce((total, file) => total + file.size, 0) >
        60 * 1024 * 1024
      )
        throw new RenderError(
          "The combined images are too large. Maximum total size is 60 MB.",
          413,
        );
      if (typeof prompt !== "string" || prompt.length > MAX_PROMPT_LENGTH)
        throw new RenderError(
          `Keep your prompt under ${MAX_PROMPT_LENGTH + 1} characters.`,
          400,
        );
      if (parentId !== null && (typeof parentId !== "string" || !parentId))
        throw new RenderError("Choose a completed video to extend.", 400);
      if (!MOTIONS.includes(motion))
        throw new RenderError("Choose a supported camera motion.", 400);
      if (!["3", "5", "10"].includes(duration))
        throw new RenderError("Choose a duration of 3, 5, or 10 seconds.", 400);
      if (!Object.hasOwn(FORMATS, format))
        throw new RenderError(
          "Choose landscape, portrait, or square format.",
          400,
        );
      if (engine === "ai" && aiBackend !== "vanta-motion")
        throw new RenderError("VANTA Motion Core is the only AI engine enabled.", 400);
      const selectedService = engine === "camera" ? service : wanService;
      const parsedBackgroundIndex = Number(backgroundIndex);
      const job = await selectedService.enqueue(
        files,
        {
          motion,
          duration: Number(duration),
          format,
          prompt,
          parentId,
          backgroundIndex: parsedBackgroundIndex,
          keepIdentity: keepIdentity !== "false",
          keepOutfit: keepOutfit !== "false",
          aiBackend,
          soundMode,
        },
        controller.signal,
      );
      res.status(202).json(selectedService.publicJob(job));
    } catch (error) {
      await Promise.all(
        (req.files || []).map((file) =>
          rm(file.path, { force: true }).catch(() => {}),
        ),
      );
      next(error);
    } finally {
      release?.();
      req.removeListener("aborted", abort);
    }
  });

  app.get("/api/videos/:id", (req, res, next) => {
    const selectedService = sourceFor(req.params.id);
    const job = selectedService.get(req.params.id);
    if (!job) return next(new RenderError("Video not found.", 404));
    res.json(selectedService.publicJob(job));
  });
  app.get("/api/videos/:id/file", (req, res, next) => {
    const selectedService = sourceFor(req.params.id);
    const job = selectedService.get(req.params.id);
    if (!job) return next(new RenderError("Video not found.", 404));
    if (job.status !== "completed")
      return next(new RenderError("This video is not ready to download.", 409));
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="${job.filename}"`,
      "Cache-Control": "private, max-age=3600",
    });
    res.sendFile(
      selectedService.filePath(job.id),
      { dotfiles: "allow" },
      (error) => {
        if (error && !res.headersSent) next(error);
      },
    );
  });
  app.delete("/api/videos/:id", async (req, res, next) => {
    try {
      if (!(await sourceFor(req.params.id).delete(req.params.id)))
        throw new RenderError("Video not found.", 404);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  app.use("/api", (_req, _res, next) =>
    next(new RenderError("API route not found.", 404)),
  );

  const distDir = options.distDir ?? path.join(webDir, "dist");
  try {
    await access(path.join(distDir, "index.html"));
    app.use(express.static(distDir));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(path.join(distDir, "index.html")),
    );
  } catch {
    /* The development client is served separately by Vite. */
  }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? "Image is too large. Maximum size is 20 MB."
          : `Upload up to ${MAX_IMAGES} images and the video settings.`,
      });
    }
    const status = error instanceof RenderError ? error.status : 500;
    res.status(status === 499 ? 400 : status).json({
      error:
        error instanceof RenderError
          ? error.message
          : "Something went wrong. Please try again.",
    });
  });
  return app;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.PORT || 3001);
  const server = app.listen(port, "127.0.0.1", (error) => {
    if (error) {
      console.error(
        `Unable to start video server on port ${port}: ${error.message}`,
      );
      process.exitCode = 1;
      void Promise.all([
        app.locals.videoService.close(),
        app.locals.wanService?.close(),
      ]);
      return;
    }
    console.log(`Vanta video server listening on port ${port}`);
  });
  const shutdown = () => {
    server.close();
    Promise.all([
      app.locals.videoService.close(),
        app.locals.wanService?.close(),
    ]).then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
