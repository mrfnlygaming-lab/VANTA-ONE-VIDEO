import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../index.js";
import { inspectImage, renderVideo } from "../renderer.js";

const exec = promisify(execFile);

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanta-video-test-"));
  const imagePath = path.join(directory, "image.png");
  await exec("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x96:rate=1",
    "-frames:v",
    "1",
    "-threads",
    "1",
    imagePath,
  ]);
  const image = await readFile(imagePath);
  const dataDir = path.join(directory, ".data");
  const app = await createApp({ dataDir, ...options });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.locals.videoService.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (settings = {}, body = image, type = "image/png") => {
    const form = new FormData();
    form.append("image", new Blob([body], { type }), "image.png");
    for (const [key, value] of Object.entries({
      duration: "3",
      format: "landscape",
      motion: "zoom-in",
      ...settings,
    }))
      form.append(key, value);
    return fetch(`${origin}/api/videos`, { method: "POST", body: form });
  };
  return { directory, dataDir, app, origin, upload, image, imagePath };
}

async function completed(origin, id) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/videos/${id}`);
    const job = await response.json();
    assert.equal(response.status, 200);
    if (job.status === "failed") assert.fail(job.error);
    if (job.status === "completed") return job;
    await delay(80);
  }
  assert.fail("Render did not finish within 45 seconds.");
}

test(
  "real upload renders a downloadable H.264 MP4 and persists across restarts",
  { timeout: 60_000 },
  async (t) => {
    const { directory, dataDir, app, origin, upload } = await fixture(t);
    const health = await fetch(`${origin}/api/health`).then((res) =>
      res.json(),
    );
    assert.deepEqual(health, { status: "ok", mode: "local" });
    const response = await upload();
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.duration, 3);
    assert.equal(accepted.status, "queued");
    const job = await completed(origin, accepted.id);
    assert.equal(job.progress, 100);
    assert.equal(job.width, 1280);
    assert.equal(job.height, 720);
    const video = await fetch(`${origin}${job.fileUrl}`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get("content-type"), /video\/mp4/);
    const outputPath = path.join(directory, "download.mp4");
    await writeFile(outputPath, Buffer.from(await video.arrayBuffer()));
    const { stdout } = await exec("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,width,height,r_frame_rate",
      "-of",
      "json",
      outputPath,
    ]);
    const metadata = JSON.parse(stdout);
    assert.equal(metadata.streams.length, 1);
    assert.equal(metadata.streams[0].codec_name, "h264");
    assert.equal(metadata.streams[0].width, 1280);
    assert.equal(metadata.streams[0].height, 720);
    assert.equal(metadata.streams[0].r_frame_rate, "24/1");
    assert.ok(Math.abs(Number(metadata.format.duration) - 3) < 0.1);
    const hashes = await exec("ffmpeg", [
      "-v",
      "error",
      "-i",
      outputPath,
      "-vf",
      "select=eq(n\\,0)+eq(n\\,71)",
      "-fps_mode",
      "passthrough",
      "-f",
      "framemd5",
      "pipe:1",
    ]);
    const frameHashes = hashes.stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(",").at(-1).trim());
    assert.equal(frameHashes.length, 2);
    assert.notEqual(
      frameHashes[0],
      frameHashes[1],
      "Zoom must produce visibly different frames.",
    );
    const range = await fetch(`${origin}${job.fileUrl}`, {
      headers: { Range: "bytes=0-31" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 32);
    assert.equal(
      (await fetch(`${origin}/api/videos`).then((res) => res.json())).videos[0]
        .id,
      job.id,
    );
    assert.deepEqual(await readdir(path.join(dataDir, "uploads")), []);

    await app.locals.videoService.close();
    const restored = await createApp({ dataDir });
    t.after(() => restored.locals.videoService.close());
    assert.equal(restored.locals.videoService.list()[0].id, job.id);
    assert.equal(await restored.locals.videoService.delete(job.id), true);
    assert.deepEqual(await readdir(path.join(dataDir, "videos")), []);
  },
);

test(
  "portrait and square outputs have their promised dimensions and duration",
  { timeout: 60_000 },
  async (t) => {
    const { directory, origin, upload } = await fixture(t);
    for (const format of ["portrait", "square"]) {
      const response = await upload({
        format,
        motion: format === "portrait" ? "pan-left" : "zoom-out",
      });
      assert.equal(response.status, 202);
      const job = await completed(origin, (await response.json()).id);
      const filePath = path.join(directory, `${format}.mp4`);
      await writeFile(
        filePath,
        Buffer.from(
          await fetch(`${origin}${job.fileUrl}`).then((res) =>
            res.arrayBuffer(),
          ),
        ),
      );
      const { stdout } = await exec("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height:format=duration",
        "-of",
        "json",
        filePath,
      ]);
      const result = JSON.parse(stdout);
      assert.equal(result.streams[0].width, 720);
      assert.equal(
        result.streams[0].height,
        format === "portrait" ? 1280 : 720,
      );
      assert.ok(Math.abs(Number(result.format.duration) - 3) < 0.1);
    }
  },
);

test("accepts actual JPEG and WebP uploads", { timeout: 45_000 }, async (t) => {
  const { directory, imagePath, origin, upload } = await fixture(t);
  for (const [extension, type] of [
    ["jpg", "image/jpeg"],
    ["webp", "image/webp"],
  ]) {
    const image = path.join(directory, `source.${extension}`);
    await exec("ffmpeg", [
      "-v",
      "error",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-threads",
      "1",
      image,
    ]);
    const response = await upload(
      { motion: "pan-right" },
      await readFile(image),
      type,
    );
    assert.equal(response.status, 202);
    const job = await completed(origin, (await response.json()).id);
    assert.equal(job.status, "completed");
  }
});

test("rejects corrupt content, unsupported formats, invalid settings, and cleans rejected uploads", async (t) => {
  const { dataDir, origin, upload } = await fixture(t);
  let response = await upload({}, Buffer.from("not an image"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JPEG/);
  response = await upload({}, Buffer.from("<svg/>"), "image/svg+xml");
  assert.equal(response.status, 400);
  response = await upload({ motion: "$(touch injected)" });
  assert.equal(response.status, 400);
  response = await upload({ duration: "Infinity" });
  assert.equal(response.status, 400);
  response = await upload({ format: "__proto__" });
  assert.equal(response.status, 400);
  assert.deepEqual(await readdir(path.join(dataDir, "uploads")), []);
  assert.deepEqual(
    await fetch(`${origin}/api/videos`).then((res) => res.json()),
    { videos: [] },
  );
});

test(
  "enforces upload size and a bounded render queue; deletion cancels work and cleans files",
  { timeout: 30_000 },
  async (t) => {
    const { dataDir, app, origin, upload } = await fixture(t, {
      maxPending: 1,
    });
    const tooLarge = await upload({}, Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.equal(tooLarge.status, 413);
    const release = app.locals.videoService.reserve();
    const busy = await upload();
    assert.equal(busy.status, 429);
    release();
    const response = await upload({ duration: "10" });
    assert.equal(response.status, 202);
    const job = await response.json();
    const deletion = await fetch(`${origin}/api/videos/${job.id}`, {
      method: "DELETE",
    });
    assert.equal(deletion.status, 204);
    assert.equal((await fetch(`${origin}/api/videos/${job.id}`)).status, 404);
    assert.deepEqual(await readdir(path.join(dataDir, "uploads")), []);
    assert.deepEqual(await readdir(path.join(dataDir, "videos")), []);
  },
);

test(
  "renderer safely crops extreme aspect ratios and composites transparent images onto black",
  { timeout: 30_000 },
  async (t) => {
    const { directory } = await fixture(t);
    const extreme = path.join(directory, "extreme.png");
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=16384x2",
      "-frames:v",
      "1",
      "-threads",
      "1",
      extreme,
    ]);
    const extremeInfo = await inspectImage(extreme);
    await renderVideo({
      imagePath: extreme,
      outputPath: path.join(directory, "extreme.mp4"),
      demuxer: extremeInfo.demuxer,
      motion: "still",
      duration: 3,
      width: 1280,
      height: 720,
    });

    const transparent = path.join(directory, "transparent.png");
    await exec("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red@0:size=80x40,format=rgba",
      "-frames:v",
      "1",
      "-threads",
      "1",
      transparent,
    ]);
    const transparentInfo = await inspectImage(transparent);
    const outputPath = path.join(directory, "transparent.mp4");
    await renderVideo({
      imagePath: transparent,
      outputPath,
      demuxer: transparentInfo.demuxer,
      motion: "still",
      duration: 3,
      width: 720,
      height: 720,
    });
    const pixel = await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        outputPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=1:1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    assert.ok(
      [...pixel.stdout].every((channel) => channel < 8),
      "Transparent RGB must not become visible.",
    );
  },
);
