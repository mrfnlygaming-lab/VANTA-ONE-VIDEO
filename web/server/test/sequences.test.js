import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../index.js";

const exec = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "vanta-sequence-test-"),
  );
  const images = [];
  for (const [color, extension, type] of [
    ["red", "png", "image/png"],
    ["lime", "jpg", "image/jpeg"],
    ["blue", "webp", "image/webp"],
  ]) {
    const filename = `${color}.${extension}`;
    const imagePath = path.join(directory, filename);
    await exec("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=${color}:size=160x96:rate=1`,
      "-frames:v",
      "1",
      "-threads",
      "1",
      imagePath,
    ]);
    images.push({ body: await readFile(imagePath), type, filename });
  }
  const dataDir = path.join(directory, ".data");
  const app = await createApp({ dataDir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await app.locals.videoService.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (selectedImages = images, settings = {}) => {
    const form = new FormData();
    for (const image of selectedImages)
      form.append(
        "image",
        new Blob([image.body], { type: image.type }),
        image.filename,
      );
    for (const [key, value] of Object.entries({
      duration: "3",
      format: "landscape",
      motion: "still",
      ...settings,
    }))
      form.append(key, value);
    return fetch(`${origin}/api/videos`, { method: "POST", body: form });
  };
  return { directory, dataDir, app, origin, images, upload };
}

async function completed(origin, id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/videos/${id}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.status === "failed") assert.fail(job.error);
    if (job.status === "completed") return job;
    await delay(80);
  }
  assert.fail("Sequence render did not finish within 60 seconds.");
}

async function downloaded(directory, origin, job, name) {
  const response = await fetch(`${origin}${job.fileUrl}`);
  assert.equal(response.status, 200);
  const filename = path.join(directory, `${name}.mp4`);
  await writeFile(filename, Buffer.from(await response.arrayBuffer()));
  return filename;
}

async function probe(filename) {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration",
    "-of",
    "json",
    filename,
  ]);
  return JSON.parse(stdout);
}

async function assertFrameColors(filename, expected) {
  const select = expected.map(([frame]) => `eq(n\\,${frame})`).join("+");
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filename,
      "-vf",
      `select=${select},scale=1:1`,
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  assert.equal(
    stdout.length,
    expected.length * 3,
    "Every requested frame must exist.",
  );
  expected.forEach(([frame, channel], index) => {
    const pixel = [...stdout.subarray(index * 3, index * 3 + 3)];
    assert.ok(
      pixel[channel] > 180,
      `Frame ${frame} has the expected dominant channel: ${pixel}.`,
    );
    assert.ok(
      pixel.every((value, candidate) => candidate === channel || value < 65),
      `Frame ${frame} keeps the uploaded image's solid color: ${pixel}.`,
    );
  });
}

async function assertCleanUploads(dataDir) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await readdir(path.join(dataDir, "uploads"))).length === 0) return;
    await delay(20);
  }
  assert.deepEqual(await readdir(path.join(dataDir, "uploads")), []);
}

test(
  "three mixed-format images keep their order and share the exact requested 24 fps duration",
  {
    timeout: 90_000,
  },
  async (t) => {
    const { directory, dataDir, origin, upload } = await fixture(t);
    const prompt = "Pan left across the scene.";
    const response = await upload(undefined, {
      duration: "5",
      prompt,
      motion: "zoom-out",
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.prompt, prompt);
    assert.equal(accepted.motion, "pan-left");
    assert.equal(accepted.imageCount, 3);
    assert.equal(accepted.duration, 5);
    assert.equal(accepted.addedDuration, 5);
    assert.equal(accepted.parentId, null);

    const job = await completed(origin, accepted.id);
    const filename = await downloaded(directory, origin, job, "sequence");
    const metadata = await probe(filename);
    assert.equal(metadata.streams[0].codec_name, "h264");
    assert.equal(metadata.streams[0].r_frame_rate, "24/1");
    assert.equal(Number(metadata.streams[0].nb_read_frames), 120);
    assert.ok(Math.abs(Number(metadata.format.duration) - 5) < 0.05);
    await assertFrameColors(filename, [
      [0, 0],
      [39, 0],
      [40, 1],
      [79, 1],
      [80, 2],
      [119, 2],
    ]);
    assert.equal(job.prompt, prompt);
    assert.equal(job.motion, "pan-left");
    assert.equal(job.imageCount, 3);
    await assertCleanUploads(dataDir);
  },
);

test(
  "extensions preserve the parent after deletion, inherit format, and can continue its last frame",
  {
    timeout: 120_000,
  },
  async (t) => {
    const { directory, dataDir, app, origin, images, upload } =
      await fixture(t);
    const parentResponse = await upload([images[0]], { format: "square" });
    assert.equal(parentResponse.status, 202);
    const parent = await completed(origin, (await parentResponse.json()).id);

    // Hold the child in the queue so deleting the source exercises the retained parent,
    // rather than merely racing a renderer that already opened the original MP4.
    const service = app.locals.videoService;
    const pump = service.pump;
    service.pump = () => {};
    let accepted;
    try {
      const childResponse = await upload([images[1], images[2]], {
        parentId: parent.id,
        format: "landscape",
        prompt: "Keep the camera still.",
      });
      assert.equal(childResponse.status, 202);
      accepted = await childResponse.json();
      assert.equal(accepted.status, "queued");
      assert.equal(accepted.parentId, parent.id);
      assert.equal(accepted.addedDuration, 3);
      assert.equal(accepted.duration, 6);
      assert.equal(accepted.imageCount, 2);
      assert.equal(accepted.format, "square");
      assert.equal(accepted.width, 720);
      assert.equal(accepted.height, 720);
      assert.equal(
        (await fetch(`${origin}/api/videos/${parent.id}`, { method: "DELETE" }))
          .status,
        204,
      );
      assert.equal(
        (await fetch(`${origin}/api/videos/${parent.id}/file`)).status,
        404,
      );
    } finally {
      service.pump = pump;
      service.pump();
    }
    const child = await completed(origin, accepted.id);
    const childFile = await downloaded(directory, origin, child, "extension");
    const childMetadata = await probe(childFile);
    assert.equal(Number(childMetadata.streams[0].nb_read_frames), 144);
    assert.ok(Math.abs(Number(childMetadata.format.duration) - 6) < 0.05);
    await assertFrameColors(childFile, [
      [0, 0],
      [71, 0],
      [72, 1],
      [107, 1],
      [108, 2],
      [143, 2],
    ]);
    const persisted = JSON.parse(
      await readFile(service.metadataPath(child.id), "utf8"),
    );
    assert.equal(persisted.prompt, "Keep the camera still.");
    assert.equal(persisted.parentId, parent.id);
    assert.equal(persisted.imageCount, 2);
    assert.equal(persisted.addedDuration, 3);
    for (const key of [
      "images",
      "workDir",
      "parentPath",
      "imagePath",
      "demuxer",
    ])
      assert.equal(
        Object.hasOwn(persisted, key),
        false,
        `Saved metadata must not expose ${key}.`,
      );

    const continuationResponse = await upload([], {
      parentId: child.id,
      format: "portrait",
      prompt: "Continue without moving the camera.",
    });
    assert.equal(continuationResponse.status, 202);
    const continuationAccepted = await continuationResponse.json();
    assert.equal(continuationAccepted.parentId, child.id);
    assert.equal(continuationAccepted.duration, 9);
    assert.equal(continuationAccepted.addedDuration, 3);
    assert.equal(continuationAccepted.imageCount, 1);
    assert.equal(continuationAccepted.format, "square");
    const continuation = await completed(origin, continuationAccepted.id);
    const continuedFile = await downloaded(
      directory,
      origin,
      continuation,
      "last-frame",
    );
    const continuedMetadata = await probe(continuedFile);
    assert.equal(Number(continuedMetadata.streams[0].nb_read_frames), 216);
    assert.ok(Math.abs(Number(continuedMetadata.format.duration) - 9) < 0.05);
    await assertFrameColors(continuedFile, [
      [0, 0],
      [71, 0],
      [72, 1],
      [107, 1],
      [108, 2],
      [143, 2],
      [144, 2],
      [215, 2],
    ]);
    await assertCleanUploads(dataDir);
    assert.deepEqual(
      (await readdir(path.join(dataDir, "videos"))).sort(),
      [
        `${child.id}.json`,
        `${child.id}.mp4`,
        `${continuation.id}.json`,
        `${continuation.id}.mp4`,
      ].sort(),
    );
  },
);

test(
  "sequence and extension validation rejects unusable requests and removes rejected uploads",
  {
    timeout: 90_000,
  },
  async (t) => {
    const { dataDir, app, origin, images, upload } = await fixture(t);
    let response = await upload(Array.from({ length: 7 }, () => images[0]));
    assert.equal(response.status, 400);
    response = await upload([images[0]], { prompt: "a".repeat(1001) });
    assert.equal(response.status, 400);
    response = await upload([], {});
    assert.equal(response.status, 400);
    response = await upload([images[0]], {
      parentId: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(response.status, 404);
    const paddedImage = { ...images[0], body: Buffer.alloc(16 * 1024 * 1024) };
    images[0].body.copy(paddedImage.body);
    response = await upload(Array.from({ length: 4 }, () => paddedImage));
    assert.equal(
      response.status,
      413,
      "Four individually permitted files must still obey the 60 MB total cap.",
    );
    await assertCleanUploads(dataDir);
    assert.deepEqual(
      (await fetch(`${origin}/api/videos`).then((res) => res.json())).videos,
      [],
    );

    const parentResponse = await upload([images[0]]);
    assert.equal(parentResponse.status, 202);
    const parent = await completed(origin, (await parentResponse.json()).id);
    const internalParent = app.locals.videoService.get(parent.id);
    const actualDuration = internalParent.duration;
    // The cap is metadata validation; there is no need to encode a 58-second fixture.
    internalParent.duration = 58;
    try {
      response = await upload([images[1]], { parentId: parent.id });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /60/);
    } finally {
      internalParent.duration = actualDuration;
    }
    await assertCleanUploads(dataDir);
    assert.deepEqual(
      (await readdir(path.join(dataDir, "videos"))).sort(),
      [`${parent.id}.json`, `${parent.id}.mp4`].sort(),
    );
  },
);
