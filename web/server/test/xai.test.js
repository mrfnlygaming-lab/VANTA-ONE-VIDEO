import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { XaiService } from "../xai-service.js";

const exec = promisify(execFile);
const API_KEY = "test-only-key-never-persist";
const REQUEST_ID = "private-provider-request-123";
const VIDEO_URL = "https://vidgen.x.ai/generated/provider-result.mp4";
let fixtureDir;
let imageFixtures;
let videoBytes;

before(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "vanta-xai-fixtures-"));
  imageFixtures = [];
  for (const [color, extension, mime] of [
    ["red", "png", "image/png"],
    ["lime", "jpg", "image/jpeg"],
    ["blue", "webp", "image/webp"],
  ]) {
    const filename = path.join(fixtureDir, `${color}.${extension}`);
    await exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      `color=${color}:size=160x96:rate=1`, "-frames:v", "1", "-threads", "1", filename,
    ]);
    imageFixtures.push({ path: filename, mime, bytes: await readFile(filename) });
  }
  const filename = path.join(fixtureDir, "provider-720p.mp4");
  await exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc2=size=1280x720:rate=24", "-t", "0.5", "-an", "-c:v", "libx264",
    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "2", filename,
  ]);
  videoBytes = await readFile(filename);
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

function successfulProvider({ pending = false, url = VIDEO_URL, moderation = true, download } = {}) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (input, options = {}) => {
    const address = String(input);
    calls.push({ url: address, options });
    if (address === "https://api.x.ai/v1/videos/generations")
      return json({ request_id: REQUEST_ID });
    if (address === `https://api.x.ai/v1/videos/${REQUEST_ID}`) {
      polls += 1;
      if (pending && polls === 1) return new Response(null, { status: 202 });
      return json({ status: "done", video: { url, respect_moderation: moderation } });
    }
    if (address === VIDEO_URL)
      return download ? download() : new Response(videoBytes, {
        headers: { "content-type": "video/mp4", "content-length": String(videoBytes.length) },
      });
    throw new Error(`Unexpected mocked URL: ${address}`);
  };
  return { fetchImpl, calls };
}

async function serviceFixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vanta-xai-test-"));
  const provider = successfulProvider();
  const service = new XaiService({
    dataDir: path.join(directory, ".data"),
    apiKey: API_KEY,
    fetchImpl: provider.fetchImpl,
    pollIntervalMs: 5,
    pollTimeoutMs: 2_000,
    ...overrides,
  });
  await service.init();
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  let serial = 0;
  async function files(count = 3) {
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const source = imageFixtures[index % imageFixtures.length];
      const filename = path.join(service.uploadDir, `input-${serial++}${path.extname(source.path)}`);
      await copyFile(source.path, filename);
      result.push({ path: filename, mimetype: source.mime, size: source.bytes.length });
    }
    return result;
  }
  return { service, directory, files, ...provider };
}

async function terminal(service, id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = service.get(id);
    assert.ok(job, "The accepted job remains available while processing.");
    if (["completed", "failed", "cancelled"].includes(job.status)) return service.publicJob(job);
    await delay(20);
  }
  assert.fail("The mocked AI job did not finish within 30 seconds.");
}

async function assertSourcesRemoved(files) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const present = await Promise.all(files.map((file) => stat(file.path).then(() => true, () => false)));
    if (!present.some(Boolean)) return;
    await delay(10);
  }
  assert.fail("Accepted upload files were not removed after the job finished.");
}

const settings = { prompt: "Bring the scene to life.", duration: 3, format: "landscape" };

for (const [count, format, aspectRatio, width, height] of [
  [3, "landscape", "16:9", 1920, 1080],
  [2, "portrait", "9:16", 1080, 1920],
]) {
  test(`AI sends all ${count} references in one request, preserves the prompt, and exports verified 1080p ${format}`, { timeout: 60_000 }, async (t) => {
    const provider = successfulProvider({ pending: true });
    const { service, files } = await serviceFixture(t, { fetchImpl: provider.fetchImpl });
    const inputs = await files(count);
    const prompt = "  A fox jumps over a fallen log.\nCamera tracks left, then settles.  ";
    const accepted = await service.enqueue(inputs, { ...settings, prompt, duration: 5, format });
    const job = await terminal(service, accepted.id);
    assert.equal(job.status, "completed", job.error);
    assert.equal(job.engine, "ai");
    assert.equal(job.prompt, prompt);
    assert.equal(job.imageCount, count);
    assert.equal(job.requestedDuration, 5);
    assert.ok(Math.abs(job.duration - 0.5) < 0.1, "Published duration comes from the actual provider video.");
    assert.equal(job.sourceResolution, "720p");
    assert.equal(job.outputResolution, "1080p");
    assert.equal(job.upscaled, true);
    assert.equal(job.width, width);
    assert.equal(job.height, height);
    assert.equal(job.extendable, false);
    assert.equal(job.canCancel, false);
    assert.match(job.cancelWarning, /continu|bill|charg/i);
    assert.equal(job.fileUrl, `/api/videos/${job.id}/file`);

    const posts = provider.calls.filter(({ options }) => options.method === "POST");
    assert.equal(posts.length, 1, "A multi-image job must make only one billable generation request.");
    const request = posts[0];
    assert.equal(request.url, "https://api.x.ai/v1/videos/generations");
    const headers = new Headers(request.options.headers);
    assert.equal(headers.get("authorization"), `Bearer ${API_KEY}`);
    assert.match(headers.get("content-type"), /application\/json/);
    const payload = JSON.parse(request.options.body);
    assert.deepEqual(payload, {
      model: "grok-imagine-video-1.5",
      prompt,
      duration: 5,
      aspect_ratio: aspectRatio,
      resolution: "720p",
      reference_images: imageFixtures.slice(0, count).map((image) => ({
        url: `data:${image.mime};base64,${image.bytes.toString("base64")}`,
      })),
    });
    const polls = provider.calls.filter(({ url }) => url.includes(`/videos/${REQUEST_ID}`));
    assert.ok(polls.length >= 2, "An empty HTTP 202 response keeps the job pending.");
    for (const poll of polls)
      assert.equal(new Headers(poll.options.headers).get("authorization"), `Bearer ${API_KEY}`);
    const download = provider.calls.find(({ url }) => url === VIDEO_URL);
    assert.ok(download);
    assert.equal(download.options.redirect, "error");
    assert.equal(new Headers(download.options.headers).has("authorization"), false);

    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name,width,height,pix_fmt:format=duration",
      "-of", "json", service.filePath(job.id),
    ]);
    const metadata = JSON.parse(stdout);
    assert.equal(metadata.streams[0].codec_name, "h264");
    assert.equal(metadata.streams[0].width, width);
    assert.equal(metadata.streams[0].height, height);
    assert.equal(metadata.streams[0].pix_fmt, "yuv420p");
    assert.ok(Number(metadata.format.duration) > 0);
    assert.ok(Number(metadata.format.duration) <= 15);
    await assertSourcesRemoved(inputs);

    const storedText = await readFile(path.join(service.videoDir, `${job.id}.json`), "utf8");
    const stored = JSON.parse(storedText);
    assert.equal(stored.prompt, prompt);
    for (const forbidden of [API_KEY, REQUEST_ID, VIDEO_URL, ...inputs.map((file) => file.path)]) {
      assert.equal(storedText.includes(forbidden), false, "Saved metadata must not contain secrets, remote identifiers, or source paths.");
      assert.equal(JSON.stringify(job).includes(forbidden), false, "Public job data must not contain secrets or private paths.");
    }
    await service.close();
    const reloaded = new XaiService({ dataDir: service.dataDir, apiKey: API_KEY, fetchImpl: provider.fetchImpl });
    await reloaded.init();
    t.after(() => reloaded.close());
    assert.equal(reloaded.get(job.id).status, "completed");
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].prompt, prompt);
    assert.equal(reloaded.list()[0].duration, job.duration);
    assert.equal(await reloaded.delete(job.id), true);
    assert.deepEqual(reloaded.list(), []);
    await assert.rejects(stat(reloaded.filePath(job.id)), { code: "ENOENT" });
  });
}

test("missing API credentials reject before any provider request and leave rejected uploads with the caller", async (t) => {
  let calls = 0;
  const { service, files } = await serviceFixture(t, {
    apiKey: "",
    fetchImpl: async () => { calls += 1; throw new Error("Must not fetch without a key."); },
  });
  const inputs = await files(1);
  await assert.rejects(service.enqueue(inputs, settings), (error) => error.status === 503);
  assert.equal(calls, 0);
  assert.ok((await stat(inputs[0].path)).isFile());
});

test("AI validates reference count, real image bytes, prompt, options, and unsupported extensions before billing", async (t) => {
  let calls = 0;
  const { service, files } = await serviceFixture(t, {
    fetchImpl: async () => { calls += 1; throw new Error("Invalid jobs must not contact the provider."); },
  });
  const inputs = await files(4);
  for (const [selected, options, expectedStatus] of [
    [[], settings, 400],
    [inputs, settings, 400],
    [[inputs[0]], { ...settings, prompt: "" }, 400],
    [[inputs[0]], { ...settings, prompt: " \n\t " }, 400],
    [[inputs[0]], { ...settings, prompt: "x".repeat(1001) }, 400],
    [[inputs[0]], { ...settings, duration: 2 }, 400],
    [[inputs[0]], { ...settings, format: "cinema" }, 400],
    [[inputs[0]], { ...settings, parentId: "00000000-0000-4000-8000-000000000000" }, 422],
  ]) {
    await assert.rejects(service.enqueue(selected, options), (error) => error.status === expectedStatus);
  }
  const fakePath = path.join(service.uploadDir, "not-an-image.png");
  await writeFile(fakePath, "This is not an image.");
  await assert.rejects(service.enqueue([{ path: fakePath, mimetype: "image/png", size: 21 }], settings), (error) => error.status === 400);
  const oversizedPath = path.join(service.uploadDir, "too-large.png");
  await copyFile(inputs[0].path, oversizedPath);
  await truncate(oversizedPath, 20 * 1024 * 1024 + 1);
  await assert.rejects(service.enqueue([{ path: oversizedPath, mimetype: "image/png", size: 1 }], settings), (error) => error.status === 413);
  assert.equal(calls, 0);
  for (const file of inputs) assert.ok((await stat(file.path)).isFile(), "Failed enqueue must preserve caller-owned inputs.");
  assert.deepEqual(service.list(), []);
});

for (const status of ["failed", "expired"]) {
  test(`provider ${status} status fails the job without a video download`, async (t) => {
    const calls = [];
    const { service, files } = await serviceFixture(t, {
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return options.method === "POST" ? json({ request_id: REQUEST_ID }) : json({ status });
      },
    });
    const inputs = await files(1);
    const accepted = await service.enqueue(inputs, settings);
    const job = await terminal(service, accepted.id);
    assert.equal(job.status, "failed");
    assert.ok(job.error);
    assert.equal(calls.some(({ url }) => url.startsWith("https://vidgen.x.ai/")), false);
    await assertSourcesRemoved(inputs);
    assert.deepEqual(service.list(), []);
    assert.deepEqual(await readdir(service.videoDir), []);
  });
}

test("moderation rejection prevents downloading the provider video", async (t) => {
  const provider = successfulProvider({ moderation: false });
  const { service, files } = await serviceFixture(t, { fetchImpl: provider.fetchImpl });
  const inputs = await files(1);
  const accepted = await service.enqueue(inputs, settings);
  const job = await terminal(service, accepted.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /moderat|safety|reject/i);
  assert.equal(provider.calls.some(({ url }) => url === VIDEO_URL), false);
  await assertSourcesRemoved(inputs);
});

for (const unsafeUrl of [
  "http://vidgen.x.ai/video.mp4",
  "https://example.com/video.mp4",
  "https://vidgen.x.ai.evil.example/video.mp4",
  "https://user:password@vidgen.x.ai/video.mp4",
  "http://127.0.0.1/internal",
]) {
  test(`provider output URL is rejected before download: ${unsafeUrl}`, async (t) => {
    const provider = successfulProvider({ url: unsafeUrl });
    const { service, files } = await serviceFixture(t, { fetchImpl: provider.fetchImpl });
    const accepted = await service.enqueue(await files(1), settings);
    const job = await terminal(service, accepted.id);
    assert.equal(job.status, "failed");
    assert.equal(provider.calls.length, 2, "An unsafe URL must never be requested.");
    assert.deepEqual(service.list(), []);
  });
}

test("a provider poll timeout fails cleanly instead of continuing indefinitely", async (t) => {
  let posts = 0;
  const { service, files } = await serviceFixture(t, {
    pollTimeoutMs: 35,
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "POST") {
        posts += 1;
        return json({ request_id: REQUEST_ID });
      }
      return new Response(null, { status: 202 });
    },
  });
  const inputs = await files(1);
  const accepted = await service.enqueue(inputs, settings);
  const job = await terminal(service, accepted.id);
  assert.equal(job.status, "failed");
  assert.match(job.error, /timed?\s*out|timeout|too long/i);
  assert.equal(posts, 1, "A timeout must not silently submit another paid generation.");
  await assertSourcesRemoved(inputs);
});

test("provider HTTP errors fail once and do not expose provider error bodies", async (t) => {
  const providerError = "private upstream diagnostic and account detail";
  let posts = 0;
  const { service, files } = await serviceFixture(t, {
    fetchImpl: async () => {
      posts += 1;
      return json({ error: { message: providerError } }, 429);
    },
  });
  const accepted = await service.enqueue(await files(1), settings);
  const job = await terminal(service, accepted.id);
  assert.equal(job.status, "failed");
  assert.equal(posts, 1);
  assert.equal(JSON.stringify(job).includes(providerError), false);
  assert.equal(JSON.stringify(job).includes(API_KEY), false);
});

test("oversized downloads and invalid video bytes never become completed videos", async (t) => {
  for (const download of [
    () => new Response("small body", { headers: { "content-length": String(100 * 1024 * 1024 + 1) } }),
    () => {
      let chunks = 0;
      const chunk = new Uint8Array(1024 * 1024);
      return new Response(new ReadableStream({
        pull(controller) {
          if (chunks++ < 101) controller.enqueue(chunk);
          else controller.close();
        },
      }), { headers: { "content-type": "video/mp4" } });
    },
    () => new Response("not an MP4", { headers: { "content-type": "video/mp4" } }),
  ]) {
    const provider = successfulProvider({ download });
    const { service, files } = await serviceFixture(t, { fetchImpl: provider.fetchImpl });
    const inputs = await files(1);
    const accepted = await service.enqueue(inputs, settings);
    const job = await terminal(service, accepted.id);
    assert.equal(job.status, "failed");
    assert.deepEqual(service.list(), []);
    assert.deepEqual(await readdir(service.videoDir), []);
    await assertSourcesRemoved(inputs);
  }
});

test("accepted AI jobs run serially rather than submitting simultaneous paid requests", async (t) => {
  let posts = 0;
  let releaseFirst;
  let firstPollStarted;
  const firstPoll = new Promise((resolve) => { firstPollStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const { service, files } = await serviceFixture(t, {
    fetchImpl: async (_url, options = {}) => {
      if (options.method === "POST") {
        posts += 1;
        return json({ request_id: `private-request-${posts}` });
      }
      if (posts === 1) {
        firstPollStarted();
        await gate;
      }
      return json({ status: "failed" });
    },
  });
  t.after(() => releaseFirst());
  const firstInputs = await files(1);
  const first = await service.enqueue(firstInputs, settings);
  const secondInputs = await files(1);
  const second = await service.enqueue(secondInputs, settings);
  try {
    await Promise.race([
      firstPoll,
      delay(2_000).then(() => assert.fail("The first queued job did not begin polling.")),
    ]);
    await delay(20);
    assert.equal(posts, 1, "The second paid submission waits while the first provider job is processing.");
  } finally {
    releaseFirst();
  }
  assert.equal((await terminal(service, first.id)).status, "failed");
  assert.equal((await terminal(service, second.id)).status, "failed");
  assert.equal(posts, 2);
  await assertSourcesRemoved([...firstInputs, ...secondInputs]);
});

test("queue reservations are bounded and releasing them is idempotent", async (t) => {
  const { service } = await serviceFixture(t, { maxPending: 2 });
  const first = service.reserve();
  const second = service.reserve();
  assert.throws(() => service.reserve(), (error) => error.status === 429);
  first();
  first();
  const replacement = service.reserve();
  second();
  replacement();
  await service.close();
  assert.throws(() => service.reserve(), (error) => error.status === 503);
});
