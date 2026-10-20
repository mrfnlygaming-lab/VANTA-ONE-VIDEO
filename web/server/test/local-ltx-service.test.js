import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../index.js";
import { LocalLtxService } from "../local-ltx-service.js";
import { XaiService } from "../xai-service.js";

test("normal VANTA server selects no-credit local AI, not xAI", async () => {
  const previous = {
    LTX_DIR: process.env.LTX_DIR,
    LTX_PYTHON: process.env.LTX_PYTHON,
    LTX_CONFIG: process.env.LTX_CONFIG,
    XAI_API_KEY: process.env.XAI_API_KEY,
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "vanta-local-ltx-test-"));
  let app;
  try {
    const ltx = path.join(root, "LTX-Video");
    await mkdir(path.join(ltx, "configs"), { recursive: true });
    await writeFile(path.join(ltx, "inference.py"), "# fake source, not run\n");
    await writeFile(path.join(ltx, "configs", "ltxv-2b-0.9.6-distilled.yaml"), "pipeline_type: base\n");
    process.env.LTX_DIR = ltx;
    process.env.LTX_PYTHON = process.execPath;
    delete process.env.LTX_CONFIG;
    process.env.XAI_API_KEY = "fake-should-never-be-used";
    app = await createApp({ dataDir: path.join(root, "data") });
    const local = app.locals.aiService;
    assert.ok(local instanceof LocalLtxService);
    assert.ok(local instanceof XaiService);
    assert.equal(local.configured, true);
    assert.notEqual(local.run, XaiService.prototype.run, "must use the local worker, not remote xAI");
    await assert.rejects(
      () => local.enqueue([], { prompt: "hello", duration: 3, format: "landscape" }),
      /one starting photo/i,
    );
  } finally {
    await app?.locals.aiService.close();
    await app?.locals.videoService.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
