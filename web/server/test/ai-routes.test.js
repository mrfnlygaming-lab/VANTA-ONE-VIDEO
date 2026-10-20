import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../index.js";

const exec = promisify(execFile);

async function fixture(t, xaiOptions) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanta-ai-routes-"));
  const imagePath = path.join(directory, "image.png");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:size=32x32",
    "-frames:v", "1", "-threads", "1", imagePath]);
  const image = await readFile(imagePath);
  const app = await createApp({ dataDir: path.join(directory, ".data"), xaiOptions });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.all([app.locals.videoService.close(), app.locals.aiService.close()]);
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const upload = (engine = "ai", count = 1, prompt = "Animate all references together.") => {
    const body = new FormData();
    for (let index = 0; index < count; index += 1)
      body.append("image", new Blob([image], { type: "image/png" }), `reference-${index}.png`);
    for (const [key, value] of Object.entries({ engine, prompt, duration: "3", format: "landscape" }))
      body.append(key, value);
    return fetch(`${origin}/api/videos`, { method: "POST", body });
  };
  return { app, origin, upload, image };
}

async function emptyUploads(app) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const directories = await Promise.all([
      readdir(app.locals.videoService.uploadDir), readdir(app.locals.aiService.uploadDir),
    ]);
    if (directories.every((entries) => entries.length === 0)) return;
    await delay(20);
  }
  assert.deepEqual(await readdir(app.locals.videoService.uploadDir), []);
  assert.deepEqual(await readdir(app.locals.aiService.uploadDir), []);
}

test("HTTP AI requests without credentials return 503 and remove multipart uploads", async (t) => {
  let providerRequests = 0;
  const { app, upload } = await fixture(t, {
    apiKey: "",
    fetchImpl: async () => { providerRequests += 1; throw new Error("No provider call is permitted."); },
  });
  const response = await upload("ai", 2);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /XAI_API_KEY/);
  assert.equal(providerRequests, 0);
  assert.equal(app.locals.videoService.pendingCount(), 0);
  assert.equal(app.locals.aiService.pendingCount(), 0);
  await emptyUploads(app);
});

test("a full camera queue leaves the separate HTTP AI queue available", { timeout: 15_000 }, async (t) => {
  const providerRequests = [];
  const { app, origin, upload, image } = await fixture(t, {
    apiKey: "test-only-no-live-provider",
    pollIntervalMs: 1,
    fetchImpl: async (url, options = {}) => {
      providerRequests.push({ url: String(url), options });
      return new Response(JSON.stringify(options.method === "POST"
        ? { request_id: "route-test-request" } : { status: "failed" }),
      { headers: { "content-type": "application/json" } });
    },
  });
  const camera = app.locals.videoService;
  const releases = Array.from({ length: camera.maxPending }, () => camera.reserve());
  try {
    assert.equal((await upload("camera")).status, 429);
    await emptyUploads(app);
    const prompt = "  Both references move together.\nKeep this complete prompt.  ";
    // FormData serializes text-field line breaks as CRLF; the server must preserve
    // the complete text that arrives rather than trimming or parsing its contents.
    const wirePrompt = prompt.replaceAll("\n", "\r\n");
    const response = await upload("ai", 2, prompt);
    assert.equal(response.status, 202, "Camera saturation must not reject an independent AI job.");
    const accepted = await response.json();
    assert.equal(accepted.engine, "ai");
    assert.equal(accepted.imageCount, 2);
    assert.equal(accepted.prompt, wirePrompt);
    assert.equal(camera.pendingCount(), camera.maxPending);
    let terminal;
    for (let count = 0; count < 100; count += 1) {
      terminal = await fetch(`${origin}/api/videos/${accepted.id}`).then((result) => result.json());
      if (terminal.status === "failed") break;
      await delay(20);
    }
    assert.equal(terminal.status, "failed", "The mocked provider failure must pass through the real AI worker.");
    const posts = providerRequests.filter(({ options }) => options.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://api.x.ai/v1/videos/generations");
    const payload = JSON.parse(posts[0].options.body);
    assert.equal(payload.prompt, wirePrompt);
    assert.deepEqual(payload.reference_images, Array.from({ length: 2 }, () => ({ url: `data:image/png;base64,${image.toString("base64")}` })));
    assert.equal(app.locals.aiService.pendingCount(), 0);
    await emptyUploads(app);
  } finally { releases.forEach((release) => release()); }
});
