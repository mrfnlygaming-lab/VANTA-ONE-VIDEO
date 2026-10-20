import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";

export class RenderError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function runProcess(
  command,
  args,
  { signal, timeout = 30_000, onProgress } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new RenderError("Generation cancelled.", 499));
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-256_000);
      if (!onProgress) return;
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        const [key, value] = line.trim().split("=");
        if (key === "out_time_us" && Number.isFinite(Number(value)))
          onProgress(Number(value));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    };
    child.on("error", (error) => {
      finish();
      reject(
        new RenderError(
          error.code === "ENOENT"
            ? `Required video tool is unavailable: ${command}. Install FFmpeg and ffprobe.`
            : "Unable to start the video renderer.",
        ),
      );
    });
    child.on("close", (code) => {
      finish();
      if (signal?.aborted)
        return reject(new RenderError("Generation cancelled.", 499));
      if (timedOut)
        return reject(
          new RenderError(
            "Video processing timed out. Try a smaller image.",
            422,
          ),
        );
      if (code !== 0)
        return reject(
          new RenderError(
            "The image could not be processed. Try another JPEG, PNG, or WebP image.",
            422,
          ),
        );
      resolve({ stdout, stderr });
    });
  });
}

export async function inspectImage(
  filePath,
  { ffprobePath = "ffprobe", signal } = {},
) {
  const file = await open(filePath, "r");
  const signature = Buffer.alloc(16);
  try {
    await file.read(signature, 0, signature.length, 0);
  } finally {
    await file.close();
  }
  let demuxer;
  let expectedCodec;
  if (
    signature
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    demuxer = "png_pipe";
    expectedCodec = "png";
  } else if (
    signature[0] === 0xff &&
    signature[1] === 0xd8 &&
    signature[2] === 0xff
  ) {
    demuxer = "jpeg_pipe";
    expectedCodec = "mjpeg";
  } else if (
    signature.toString("ascii", 0, 4) === "RIFF" &&
    signature.toString("ascii", 8, 12) === "WEBP"
  ) {
    demuxer = "webp_pipe";
    expectedCodec = "webp";
  } else {
    throw new RenderError("Choose a valid JPEG, PNG, or WebP image.", 400);
  }
  let result;
  try {
    result = await runProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        demuxer,
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "json",
        filePath,
      ],
      { signal, timeout: 15_000 },
    );
  } catch (error) {
    if (error.status === 422)
      throw new RenderError(
        "This image is damaged or unsupported. Try another image.",
        400,
      );
    throw error;
  }
  let stream;
  try {
    stream = JSON.parse(result.stdout).streams?.[0];
  } catch {
    /* handled below */
  }
  if (
    stream?.codec_name !== expectedCodec ||
    !Number.isInteger(stream.width) ||
    !Number.isInteger(stream.height) ||
    stream.width < 2 ||
    stream.height < 2 ||
    stream.width > 16_384 ||
    stream.height > 16_384 ||
    stream.width * stream.height > 40_000_000
  ) {
    throw new RenderError(
      "Use an image between 2 and 16,384 pixels per side, up to 40 megapixels.",
      400,
    );
  }
  return { demuxer, width: stream.width, height: stream.height };
}

export const FORMATS = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
  square: { width: 720, height: 720 },
};
export const MOTIONS = [
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "still",
];
const COLOR_FILTER =
  "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709";
const COLOR_OPTIONS = [
  "-color_range",
  "tv",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
];

export async function renderVideo(
  {
    imagePath,
    outputPath,
    demuxer,
    motion,
    duration,
    width,
    height,
    frames: requestedFrames,
  },
  { ffmpegPath = "ffmpeg", ffprobePath = "ffprobe", signal, onProgress } = {},
) {
  const frames = requestedFrames ?? Math.round(duration * 24);
  const position = `on/${frames - 1}`;
  let zoom = "1";
  let x = "iw/2-iw/zoom/2";
  const y = "ih/2-ih/zoom/2";
  if (motion === "zoom-in") zoom = `1+0.16*${position}`;
  if (motion === "zoom-out") zoom = `1.16-0.16*${position}`;
  if (motion === "pan-left" || motion === "pan-right") {
    zoom = "1.16";
    x =
      motion === "pan-left"
        ? `(iw-iw/zoom)*(1-${position})`
        : `(iw-iw/zoom)*${position}`;
  }
  // Crop before scaling: extreme source aspect ratios must never allocate huge intermediates.
  // The bounded 2x canvas lets small source images move smoothly instead of jumping pixels.
  const filter = [
    "format=rgba",
    `crop=w='min(iw,max(2,ih*${width}/${height}))':h='min(ih,max(2,iw*${height}/${width}))'`,
    `scale=${width * 2}:${height * 2}[image];color=c=black:s=${width * 2}x${height * 2}:r=24[background];[background][image]overlay=shortest=1`,
    `zoompan=z='${zoom}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=24`,
    "setsar=1",
    COLOR_FILTER,
  ].join(",");
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "2",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      demuxer,
      "-i",
      imagePath,
      "-filter_threads",
      "1",
      "-filter_complex_threads",
      "1",
      "-vf",
      filter,
      "-frames:v",
      String(frames),
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      ...COLOR_OPTIONS,
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      outputPath,
    ],
    { signal, timeout: 120_000, onProgress },
  );
  await verifyVideo(
    outputPath,
    { width, height, duration: frames / 24, frames },
    { ffprobePath, signal },
  );
}

async function verifyVideo(
  outputPath,
  { width, height, duration, frames },
  { ffprobePath = "ffprobe", signal } = {},
) {
  const result = await runProcess(
    ffprobePath,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "mov",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate,nb_frames,color_range,color_space,color_transfer,color_primaries:format=duration",
      "-of",
      "json",
      outputPath,
    ],
    { signal, timeout: 15_000 },
  );
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    /* handled below */
  }
  const stream = output?.streams?.[0];
  if (
    output?.streams?.length !== 1 ||
    stream?.codec_name !== "h264" ||
    stream.width !== width ||
    stream.height !== height ||
    stream.r_frame_rate !== "24/1" ||
    Number(stream.nb_frames) !== frames ||
    !Number.isFinite(Number(output?.format?.duration)) ||
    Math.abs(Number(output?.format?.duration) - duration) > 0.1
  ) {
    throw new RenderError(
      "The generated video could not be verified. Please try again.",
    );
  }
  return output;
}

export async function renderSequence(
  job,
  { ffmpegPath = "ffmpeg", ffprobePath = "ffprobe", signal, onProgress } = {},
) {
  const {
    workDir,
    parentPath,
    addedDuration,
    width,
    height,
    motion,
    outputPath,
  } = job;
  const options = { ffmpegPath, ffprobePath, signal };
  let images = job.images;
  if (!images.length) {
    const imagePath = path.join(workDir, "last-frame.png");
    // Reverse only the final quarter-second to obtain the actual final frame with bounded memory.
    await runProcess(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "mov",
        "-sseof",
        "-0.25",
        "-i",
        parentPath,
        "-filter_threads",
        "1",
        "-vf",
        "reverse",
        "-frames:v",
        "1",
        "-threads",
        "1",
        imagePath,
      ],
      { signal, timeout: 30_000 },
    );
    images = [
      {
        imagePath,
        ...(await inspectImage(imagePath, { ffprobePath, signal })),
      },
    ];
  }
  const totalFrames = Math.round(addedDuration * 24);
  const segments = [];
  if (parentPath) {
    const parentDuration = job.duration - addedDuration;
    const metadata = await verifyVideo(
      parentPath,
      {
        width,
        height,
        duration: parentDuration,
        frames: Math.round(parentDuration * 24),
      },
      options,
    );
    const stream = metadata.streams[0];
    const needsNormalization =
      stream.color_range !== "tv" ||
      stream.color_space !== "bt709" ||
      stream.color_transfer !== "bt709" ||
      stream.color_primaries !== "bt709";
    if (needsNormalization) {
      // Older saved videos may predate fixed color tagging. Preserve their frames while
      // matching new segments so H.264 decoders never switch interpretation mid-video.
      const normalizedPath = path.join(workDir, "parent-normalized.mp4");
      await runProcess(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-threads",
          "2",
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          "mov",
          "-i",
          parentPath,
          "-filter_threads",
          "1",
          "-vf",
          COLOR_FILTER,
          "-map",
          "0:v:0",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          ...COLOR_OPTIONS,
          "-fps_mode",
          "passthrough",
          "-movflags",
          "+faststart",
          normalizedPath,
        ],
        { signal, timeout: 120_000 },
      );
      await verifyVideo(
        normalizedPath,
        {
          width,
          height,
          duration: parentDuration,
          frames: Math.round(parentDuration * 24),
        },
        options,
      );
      segments.push(normalizedPath);
    } else segments.push(parentPath);
  }
  let completedFrames = 0;
  for (let index = 0; index < images.length; index += 1) {
    const frames =
      Math.floor(totalFrames / images.length) +
      (index < totalFrames % images.length ? 1 : 0);
    const segmentPath = path.join(workDir, `segment-${index}.mp4`);
    const offset = (completedFrames / 24) * 1_000_000;
    await renderVideo(
      {
        ...images[index],
        outputPath: segmentPath,
        motion,
        duration: frames / 24,
        frames,
        width,
        height,
      },
      {
        ...options,
        onProgress: (time) => onProgress?.(offset + time),
      },
    );
    segments.push(segmentPath);
    completedFrames += frames;
  }
  const manifestPath = path.join(workDir, "sequence.ffconcat");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    manifestPath,
    `ffconcat version 1.0\n${segments.map((file) => `file ${quote(file)}`).join("\n")}\n`,
  );
  await runProcess(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "2",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      manifestPath,
      "-map",
      "0:v:0",
      "-an",
      "-c:v",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { signal, timeout: 60_000 },
  );
  await verifyVideo(
    outputPath,
    {
      width,
      height,
      duration: job.duration,
      frames: Math.round(job.duration * 24),
    },
    options,
  );
  onProgress?.(addedDuration * 1_000_000);
}
