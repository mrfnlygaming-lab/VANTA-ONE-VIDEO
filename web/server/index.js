import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORMATS, MOTIONS, RenderError } from "./renderer.js";
import { VideoService } from "./video-service.js";

const webDir = fileURLToPath(new URL("..", import.meta.url));

export async function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  const service = new VideoService({
    dataDir: path.join(webDir, ".data"),
    ...options,
  });
  await service.init();
  app.locals.videoService = service;
  const upload = multer({
    storage: multer.diskStorage({
      destination: service.uploadDir,
      filename: (_req, _file, callback) =>
        callback(null, `${randomUUID()}.image`),
    }),
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: 1,
      fields: 8,
      parts: 10,
      fieldSize: 1024,
    },
    fileFilter: (_req, file, callback) => {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
        return callback(
          new RenderError("Choose a JPEG, PNG, or WebP image.", 400),
        );
      }
      callback(null, true);
    },
  }).single("image");

  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", mode: "local" }),
  );
  app.get("/api/capabilities", (_req, res) =>
    res.json({ local: true, ai: false }),
  );
  app.get("/api/videos", (_req, res) => res.json({ videos: service.list() }));

  app.post("/api/videos", async (req, res, next) => {
    let release;
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    try {
      release = service.reserve();
      await new Promise((resolve, reject) =>
        upload(req, res, (error) => (error ? reject(error) : resolve())),
      );
      if (!req.file)
        throw new RenderError("Upload an image to generate a video.", 400);
      const {
        motion = "zoom-in",
        duration = "5",
        format = "landscape",
      } = req.body;
      if (!MOTIONS.includes(motion))
        throw new RenderError("Choose a supported camera motion.", 400);
      if (!["3", "5", "10"].includes(duration))
        throw new RenderError("Choose a duration of 3, 5, or 10 seconds.", 400);
      if (!Object.hasOwn(FORMATS, format))
        throw new RenderError(
          "Choose landscape, portrait, or square format.",
          400,
        );
      const job = await service.enqueue(
        req.file,
        { motion, duration: Number(duration), format },
        controller.signal,
      );
      res.status(202).json(service.publicJob(job));
    } catch (error) {
      if (req.file?.path)
        await rm(req.file.path, { force: true }).catch(() => {});
      next(error);
    } finally {
      release?.();
      req.removeListener("aborted", abort);
    }
  });

  app.get("/api/videos/:id", (req, res, next) => {
    const job = service.get(req.params.id);
    if (!job) return next(new RenderError("Video not found.", 404));
    res.json(service.publicJob(job));
  });
  app.get("/api/videos/:id/file", (req, res, next) => {
    const job = service.get(req.params.id);
    if (!job) return next(new RenderError("Video not found.", 404));
    if (job.status !== "completed")
      return next(new RenderError("This video is not ready to download.", 409));
    res.set({
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="${job.filename}"`,
      "Cache-Control": "private, max-age=3600",
    });
    res.sendFile(service.filePath(job.id), { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  });
  app.delete("/api/videos/:id", async (req, res, next) => {
    try {
      if (!(await service.delete(req.params.id)))
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
      return res
        .status(tooLarge ? 413 : 400)
        .json({
          error: tooLarge
            ? "Image is too large. Maximum size is 20 MB."
            : "Upload one image and the video settings.",
        });
    }
    const status = error instanceof RenderError ? error.status : 500;
    res
      .status(status === 499 ? 400 : status)
      .json({
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
  const server = app.listen(port, "0.0.0.0", (error) => {
    if (error) {
      console.error(`Unable to start video server on port ${port}: ${error.message}`);
      process.exitCode = 1;
      void app.locals.videoService.close();
      return;
    }
    console.log(`Vanta video server listening on port ${port}`);
  });
  const shutdown = () => {
    server.close();
    app.locals.videoService.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
