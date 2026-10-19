import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const sample = await readFile(path.join(root, "public/sample-scene.svg"));
const favicon = await readFile(path.join(root, "public/favicon.svg"));
const result = await build({
  root,
  configFile: false,
  publicDir: false,
  plugins: [react()],
  define: {
    __VANTA_EXAMPLE__: JSON.stringify(
      `data:image/svg+xml;base64,${sample.toString("base64")}`,
    ),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    write: false,
    minify: true,
    cssCodeSplit: false,
    lib: {
      entry: path.join(root, "src/main-standalone.tsx"),
      formats: ["iife"],
      name: "VantaStudio",
    },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap(
  (item) => item.output,
);
const js = outputs.find((item) => item.type === "chunk")?.code;
const css = outputs.find(
  (item) => item.type === "asset" && item.fileName.endsWith(".css"),
)?.source;
if (!js || !css)
  throw new Error("Standalone build did not produce its script and styles.");
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111311"><title>VANTA — Open & Create</title><link rel="icon" href="data:image/svg+xml;base64,${favicon.toString("base64")}"><style>${String(css).replace(/<\/style/gi, "<\\/style")}</style></head>
<body><div id="root"></div><noscript>This app needs JavaScript. Save this HTML file, then open it in Chrome or Edge with JavaScript enabled.</noscript><script>${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/VANTA-OPEN.html"), html);
console.log(
  `Standalone app: dist/VANTA-OPEN.html (${Math.round(Buffer.byteLength(html) / 1024)} KB). Open directly in a browser; no server needed.`,
);
