import { useEffect, useRef, useState } from "react";
import { request as api, ApiError, runtime } from "./runtime";
import ImageSelector, { validateImages } from "./ImageSelector";
import {
  MAX_PROMPT_LENGTH,
  MAX_TOTAL_DURATION,
  promptMotion,
} from "../shared/prompt.js";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clock3,
  Film,
  Layers3,
  LoaderCircle,
  Monitor,
  MoveLeft,
  MoveRight,
  Plus,
  Scan,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type Motion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "still";
type Format = "landscape" | "portrait" | "square";
type Video = {
  id: string;
  status: string;
  progress: number;
  duration: number;
  format: Format;
  motion: Motion | null;
  width: number;
  height: number;
  createdAt: string;
  fileUrl: string | null;
  error: string | null;
  extension?: string;
  filename?: string;
  persisted?: boolean;
  warning?: string | null;
  prompt?: string;
  parentId?: string | null;
  addedDuration?: number;
  imageCount?: number;
  engine?: "ai" | "camera";
  extendable?: boolean;
  upscaled?: boolean;
  sourceResolution?: string;
};
const motions = [
  {
    id: "zoom-in" as Motion,
    title: "Push in",
    description: "Move closer to the moment",
    icon: ZoomIn,
  },
  {
    id: "zoom-out" as Motion,
    title: "Pull out",
    description: "Reveal the bigger picture",
    icon: ZoomOut,
  },
  {
    id: "pan-left" as Motion,
    title: "Pan left",
    description: "Drift across your scene",
    icon: MoveLeft,
  },
  {
    id: "pan-right" as Motion,
    title: "Pan right",
    description: "Follow a new perspective",
    icon: MoveRight,
  },
  {
    id: "still" as Motion,
    title: "Still",
    description: "Let the image speak",
    icon: Scan,
  },
];
const formats: {
  id: Format;
  title: string;
  ratio: string;
  icon: typeof Monitor;
}[] = [
  { id: "landscape", title: "Landscape", ratio: "16:9", icon: Monitor },
  { id: "portrait", title: "Portrait", ratio: "9:16", icon: Film },
  { id: "square", title: "Square", ratio: "1:1", icon: Square },
];

export default function App() {
  const [page, setPage] = useState<"create" | "library">("create");
  const [files, setFiles] = useState<File[]>([]);
  const [engine, setEngine] = useState<"ai" | "camera">("ai");
  const [aiAvailable, setAiAvailable] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion>("zoom-in");
  const [format, setFormat] = useState<Format>("landscape");
  const [duration, setDuration] = useState(5);
  const [job, setJob] = useState<Video | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);

  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(false);
  const [exportExtension, setExportExtension] = useState("mp4");
  const [previewMotion, setPreviewMotion] = useState(false);
  const [extensionTarget, setExtensionTarget] = useState<Video | null>(null);
  const [extensionPrompt, setExtensionPrompt] = useState("");
  const [extensionDuration, setExtensionDuration] = useState(3);
  const [extensionFiles, setExtensionFiles] = useState<File[]>([]);
  const [loadingExtension, setLoadingExtension] = useState(false);
  const extensionModal = useRef<HTMLElement>(null);
  const offeredExtensions = useRef(new Set<string>());
  const extensionVersion = useRef(0);
  const file = files[0] ?? null;
  const modal = useRef<HTMLElement>(null);
  const sourceVersion = useRef(0);
  const active =
    submitting || job?.status === "queued" || job?.status === "processing";
  const resolvedMotion =
    engine === "camera" ? promptMotion(prompt) || motion : motion;
  const selectedMotion = motions.find((item) => item.id === resolvedMotion)!;
  const completed = job?.status === "completed" && job.fileUrl;

  const refreshVideos = () =>
    api<{ videos: Video[] }>("/api/videos").then((data) =>
      setVideos(data.videos),
    );
  useEffect(() => {
    const health = () =>
      api<{ status: string }>("/api/health")
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    void health();
    api<{ extension?: string; storageWarning?: string; ai?: boolean }>(
      "/api/capabilities",
    )
      .then((info) => {
        setAiAvailable(info.ai === true);
        if (info.extension) setExportExtension(info.extension);
        if (info.storageWarning) setError(info.storageWarning);
      })
      .catch((err) => {
        if (runtime.standalone)
          setError(
            err instanceof Error
              ? err.message
              : "This browser cannot record video. Try Chrome or Edge.",
          );
      });
    const timer = window.setInterval(health, 10_000);
    refreshVideos().catch(() => {});
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!file) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await api<Video>(`/api/videos/${job.id}`);
        if (disposed) return;
        setJob(next);
        if (next.status === "completed") {
          await refreshVideos();
          if (next.warning) setError(next.warning);
        }
        if (next.status === "failed")
          setError(
            next.error ||
              "The video could not be rendered. Try a different image.",
          );
      } catch (err) {
        if (!disposed) {
          if (err instanceof ApiError && err.status === 404) setJob(null);
          setError(
            err instanceof Error ? err.message : "Connection interrupted.",
          );
        }
      }
    };
    const timer = window.setInterval(poll, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  useEffect(() => {
    if (!help) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelp(false);
      if (event.key === "Tab") {
        const buttons =
          modal.current?.querySelectorAll<HTMLButtonElement>("button");
        if (!buttons?.length) return;
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      previousFocus?.focus();
    };
  }, [help]);

  async function selectFiles(candidates: File[]) {
    if (!candidates.length || active) return;
    const version = ++sourceVersion.current;
    setError(null);
    setLoadingImage(true);
    try {
      if (engine === "ai" && files.length + candidates.length > 3)
        throw new Error("Choose up to 3 reference images for one AI scene.");
      const next = await validateImages(candidates, files);
      if (version === sourceVersion.current) {
        setFiles(next);
        setJob(null);
        setPreviewMotion(false);
      }
    } catch (err) {
      if (version === sourceVersion.current)
        setError(
          err instanceof Error ? err.message : "Could not open the images.",
        );
    } finally {
      if (version === sourceVersion.current) setLoadingImage(false);
    }
  }

  async function selectExtensionFiles(candidates: File[]) {
    if (!candidates.length || active) return;
    const version = ++extensionVersion.current;
    setLoadingExtension(true);
    setError(null);
    try {
      const next = await validateImages(candidates, extensionFiles);
      if (version === extensionVersion.current) setExtensionFiles(next);
    } catch (err) {
      if (version === extensionVersion.current)
        setError(
          err instanceof Error ? err.message : "Could not open the images.",
        );
    } finally {
      if (version === extensionVersion.current) setLoadingExtension(false);
    }
  }

  function openExtension(video: Video) {
    if (
      video.extendable === false ||
      video.engine === "ai" ||
      video.duration + 3 > MAX_TOTAL_DURATION
    )
      return;
    extensionVersion.current++;
    setLoadingExtension(false);
    setExtensionFiles([]);
    setExtensionPrompt("");
    setExtensionDuration(3);
    setExtensionTarget(video);
  }

  useEffect(() => {
    if (job?.status === "completed" && !offeredExtensions.current.has(job.id)) {
      offeredExtensions.current.add(job.id);
      openExtension(job);
    }
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!extensionTarget) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    extensionModal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !active) setExtensionTarget(null);
      if (event.key !== "Tab") return;
      const controls = extensionModal.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]),input:not([disabled]):not([hidden]),textarea:not([disabled]),select:not([disabled]),a[href]",
      );
      if (!controls?.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [extensionTarget?.id, active]);

  async function useExample() {
    setLoadingImage(true);
    setError(null);
    try {
      const image = new Image();
      image.src = runtime.exampleImage;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1000;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) =>
            result
              ? resolve(result)
              : reject(new Error("Could not load the example.")),
          "image/png",
        ),
      );
      await selectFiles([
        new File([blob], "Alpine-still.png", { type: "image/png" }),
      ]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the example.",
      );
    } finally {
      setLoadingImage(false);
    }
  }

  async function generate() {
    if (!file || active) return;
    if (
      engine === "ai" &&
      (!aiAvailable || !prompt.trim() || files.length > 3)
    ) {
      setError(
        "AI scenes need the server version with XAI_API_KEY configured, 1–3 reference images, and a full scene prompt.",
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    setPreviewMotion(false);
    try {
      const data = new FormData();
      files.forEach((image) => data.append("image", image));
      data.append("prompt", engine === "ai" ? prompt : prompt.trim());
      data.append("engine", engine);
      data.append("motion", motion);
      data.append("format", format);
      data.append("duration", String(duration));
      setJob(await api<Video>("/api/videos", { method: "POST", body: data }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not start the video.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function extendVideo() {
    if (!extensionTarget || active || loadingExtension) return;
    setSubmitting(true);
    setError(null);
    setPreviewMotion(false);
    try {
      const data = new FormData();
      extensionFiles.forEach((image) => data.append("image", image));
      data.append("parentId", extensionTarget.id);
      data.append("prompt", extensionPrompt.trim());
      data.append("motion", extensionTarget.motion ?? "zoom-in");
      data.append("format", extensionTarget.format);
      data.append("duration", String(extensionDuration));
      const next = await api<Video>("/api/videos", {
        method: "POST",
        body: data,
      });
      setFormat(extensionTarget.format);
      setEngine("camera");
      setJob(next);
      setPage("create");
      setExtensionTarget(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not extend the video.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function removeVideo(video: Video) {
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      if (job?.id === video.id) setJob(null);
      if (extensionTarget?.id === video.id) setExtensionTarget(null);
      await refreshVideos();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not remove the video.",
      );
    }
  }

  function newVideo() {
    setPage("create");
    if (!active) {
      setJob(null);
      setError(null);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={newVideo} aria-label="Vanta home">
          <span className="brand-symbol">V</span>
          <span>
            VANTA<span className="brand-one">ONE</span>
          </span>
        </button>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={page === "create" ? "nav-link selected" : "nav-link"}
            onClick={() => setPage("create")}
          >
            <Clapperboard size={18} />
            Create video
            <Plus size={16} className="nav-end" />
          </button>
          <button
            className={page === "library" ? "nav-link selected" : "nav-link"}
            onClick={() => {
              setPage("library");
              refreshVideos().catch(() => {});
            }}
          >
            <Layers3 size={18} />
            My videos<span className="count">{videos.length}</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="little-orbit">
            <Sparkles size={20} />
          </div>
          <h3>Make a little motion.</h3>
          <p>
            A single image can tell
            <br />a whole new story.
          </p>
          <span className="tiny-label">MADE WITH VANTA</span>
        </div>
        <div className="sidebar-bottom">
          <span className="avatar">V</span>
          <div>
            <strong>Personal workspace</strong>
            <span>Local video studio</span>
          </div>
          <ChevronDown size={14} />
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronDown size={12} />
            <span>{page === "create" ? "Image to video" : "My videos"}</span>
          </div>
          <div className="topbar-actions">
            <span className="engine-status">
              <i className={online ? "online" : ""} />
              {online
                ? runtime.standalone
                  ? "Browser renderer ready"
                  : "Renderer online"
                : "Connecting to renderer"}
            </span>
            <button
              className="icon-button help-trigger"
              aria-label="How it works"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        <main>
          {runtime.standalone && (
            <div className="standalone-notice">
              <ShieldCheck size={16} />
              <span>
                <strong>Ready to use — no server needed.</strong> Choose a photo
                or try the example below. Keep this tab open while rendering.
              </span>
            </div>
          )}
          {page === "create" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> THE MOTION STUDIO
                  </div>
                  <h1>
                    Give your scene a little life<span>.</span>
                  </h1>
                  <p>
                    Combine your references. Describe the action. Create one
                    scene.
                  </p>
                </div>
                <span className="version-tag">
                  <Sparkles size={13} /> Image to video
                </span>
              </div>
              <div className="studio-grid">
                <section className="settings-panel" aria-label="Video settings">
                  <label className="field-label" htmlFor="generation-engine">
                    Generation mode
                  </label>
                  <select
                    id="generation-engine"
                    className="engine-select"
                    value={engine}
                    disabled={!!active}
                    onChange={(event) => {
                      setEngine(event.target.value as "ai" | "camera");
                      setJob(null);
                      setPreviewMotion(false);
                    }}
                  >
                    <option value="ai">
                      AI scene · all references together
                    </option>
                    <option value="camera">
                      Camera sequence · pan and zoom
                    </option>
                  </select>
                  <p className="prompt-explanation">
                    {engine === "ai"
                      ? "Generate subject movement in one coherent scene from up to three references and your complete prompt."
                      : "Play up to six still images in order with camera movement. This mode does not animate subjects."}
                  </p>
                  {engine === "ai" && !aiAvailable && (
                    <div className="ai-setup-message" role="status">
                      {runtime.standalone
                        ? "AI scenes need the server version with an xAI API key. This offline file can export camera sequences at 1080p; select Camera sequence to use it without a server."
                        : "AI scenes are waiting for XAI_API_KEY in Environment settings. Save the key securely there, then restart the server. Uses your xAI account credits."}
                    </div>
                  )}
                  <div className="section-divider" />
                  <div className="section-title">
                    <h2>
                      <span className="step">01</span>{" "}
                      {engine === "ai" ? "Scene references" : "Your images"}
                    </h2>
                    <span className="small-label">JPG, PNG, WEBP</span>
                  </div>
                  <ImageSelector
                    files={files}
                    maxImages={engine === "ai" ? 3 : 6}
                    references={engine === "ai"}
                    onAdd={selectFiles}
                    onChange={(next) => {
                      sourceVersion.current++;
                      setFiles(next);
                      setJob(null);
                      setPreviewMotion(false);
                    }}
                    disabled={!!active}
                    loading={loadingImage}
                  />
                  <button
                    className="example-button"
                    disabled={
                      active ||
                      loadingImage ||
                      files.length >= (engine === "ai" ? 3 : 6)
                    }
                    onClick={useExample}
                  >
                    <img src={runtime.exampleImage} alt="" />
                    <span>
                      No image handy? <strong>Try an example</strong>
                    </span>
                    <ArrowUpRight size={15} />
                  </button>
                  <div className="section-divider" />
                  <div className="section-title">
                    <h2>
                      <span className="step">02</span> Your prompt
                    </h2>
                    <span className="small-label">
                      {engine === "ai" ? "REQUIRED" : "OPTIONAL"}
                    </span>
                  </div>
                  <label className="field-label" htmlFor="video-prompt">
                    {engine === "ai"
                      ? "Full scene prompt"
                      : "Prompt / camera direction"}
                  </label>
                  <textarea
                    id="video-prompt"
                    className="prompt-input"
                    rows={3}
                    maxLength={MAX_PROMPT_LENGTH}
                    disabled={!!active}
                    value={prompt}
                    onChange={(event) => {
                      setPrompt(event.target.value);
                      setJob(null);
                      setPreviewMotion(false);
                    }}
                    placeholder={
                      engine === "ai"
                        ? "Put <IMAGE_0> and <IMAGE_1> together in one scene. They walk side by side, with natural body movement and a continuous camera shot…"
                        : "Slowly pan left across the landscape…"
                    }
                  />
                  <div className="prompt-examples">
                    {(engine === "ai"
                      ? [
                          "Natural movement",
                          "One continuous shot",
                          "Cinematic lighting",
                        ]
                      : ["Zoom in", "Pan left", "Pan right"]
                    ).map((text) => (
                      <button
                        key={text}
                        disabled={!!active}
                        onClick={() => {
                          setPrompt(
                            engine === "ai"
                              ? `${prompt}${prompt ? ", " : ""}${text.toLowerCase()}`
                              : text,
                          );
                          setJob(null);
                        }}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                  {engine === "ai" && files.length > 0 && (
                    <div className="prompt-examples reference-tokens">
                      {files.map((_, index) => (
                        <button
                          key={index}
                          disabled={!!active}
                          onClick={() =>
                            setPrompt(
                              (value) =>
                                `${value}${value ? " " : ""}<IMAGE_${index}>`,
                            )
                          }
                        >
                          Insert Image {index + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="prompt-explanation">
                    {engine === "ai"
                      ? "Your entire prompt is sent to Grok unchanged with all reference images in one request. Describe the actions and how the subjects interact. Image references do not play as separate shots."
                      : `${promptMotion(prompt) ? `Camera direction: ${selectedMotion.title}.` : "Camera words control movement; other details are saved as notes."} This mode does not generate AI subject motion.`}
                  </p>
                  <div className="section-divider" />
                  <div className="section-title">
                    <h2>
                      <span className="step">03</span> Make it move
                    </h2>
                    <SlidersHorizontal size={15} className="muted" />
                  </div>
                  {engine === "camera" && (
                    <>
                      <label className="field-label" htmlFor="motion">
                        Camera movement
                      </label>
                      <div className="motion-select">
                        <span className="motion-icon">
                          <selectedMotion.icon size={19} />
                        </span>
                        <div>
                          <strong>{selectedMotion.title}</strong>
                          <span>{selectedMotion.description}</span>
                        </div>
                        <ChevronDown size={15} />
                        <select
                          id="motion"
                          value={resolvedMotion}
                          disabled={active}
                          onChange={(event) => {
                            setMotion(event.target.value as Motion);
                            if (promptMotion(prompt)) setPrompt("");
                            setJob(null);
                            setPreviewMotion(false);
                          }}
                        >
                          {motions.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                  <div className="field-row">
                    <div>
                      <span className="field-label">Total clip duration</span>
                      <div className="segmented">
                        {[3, 5, 10].map((seconds) => (
                          <button
                            className={duration === seconds ? "active" : ""}
                            key={seconds}
                            disabled={active}
                            onClick={() => {
                              setDuration(seconds);
                              setJob(null);
                            }}
                          >
                            {seconds}s
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span className="field-label">Resolution</span>
                      <div className="resolution-value">
                        <Monitor size={15} />
                        1080p<span>FHD</span>
                      </div>
                    </div>
                  </div>
                  <span className="field-label">Aspect ratio</span>
                  <div className="format-options">
                    {formats.map((item) => (
                      <button
                        key={item.id}
                        className={
                          format === item.id
                            ? "format-option active"
                            : "format-option"
                        }
                        disabled={active}
                        onClick={() => {
                          setFormat(item.id);
                          setJob(null);
                          setPreviewMotion(false);
                        }}
                      >
                        <item.icon size={18} />
                        <strong>{item.ratio}</strong>
                        <span>{item.title}</span>
                      </button>
                    ))}
                  </div>
                  <div className="render-note">
                    <ShieldCheck size={15} />
                    <span>
                      {engine === "ai"
                        ? "Uses xAI credits · Images and prompts sent to xAI"
                        : "No credits. No API key. Camera animation only."}
                    </span>
                  </div>
                  <button
                    className="generate-button"
                    disabled={
                      !file ||
                      active ||
                      loadingImage ||
                      !online ||
                      (engine === "ai" &&
                        (!aiAvailable || !prompt.trim() || files.length > 3))
                    }
                    onClick={generate}
                  >
                    {active ? (
                      <LoaderCircle size={18} className="spin" />
                    ) : (
                      <Sparkles size={18} />
                    )}
                    <span>
                      {submitting
                        ? runtime.standalone
                          ? "Opening image…"
                          : "Uploading image…"
                        : active
                          ? job?.status === "queued"
                            ? "Waiting to render…"
                            : "Creating your video…"
                          : engine === "ai"
                            ? "Generate AI scene"
                            : "Generate video"}
                    </span>
                    {!active && <ArrowRight size={18} />}
                  </button>
                  <p className="settings-footnote">
                    {engine === "ai"
                      ? "AI reference scenes: 720p generation → 1080p upscale"
                      : `Camera animation · 24 fps · 1080p ${exportExtension.toUpperCase()} export`}
                  </p>
                </section>

                <section className="preview-panel" aria-label="Video preview">
                  <div className="preview-header">
                    <h2>
                      Preview <span className="subtle-dot" />
                    </h2>
                    <span>
                      {completed
                        ? "YOUR VIDEO IS READY"
                        : active
                          ? "RENDERING YOUR SCENE"
                          : "YOUR NEXT SCENE STARTS HERE"}
                    </span>
                  </div>
                  <div className={`preview-stage ${format}`}>
                    {completed ? (
                      <video
                        key={job.id}
                        src={job.fileUrl!}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label="Generated video"
                      />
                    ) : (
                      <div
                        className={`scene-frame ${previewMotion ? `animate ${resolvedMotion}` : ""}`}
                        style={
                          {
                            "--duration": `${duration}s`,
                          } as React.CSSProperties
                        }
                      >
                        <img
                          src={imageUrl || runtime.exampleImage}
                          alt={
                            imageUrl
                              ? "Starting frame preview"
                              : "Example alpine landscape illustration"
                          }
                        />
                        <div className="scene-vignette" />
                        <span className="scene-badge">
                          <span />{" "}
                          {imageUrl ? "STARTING FRAME" : "EXAMPLE SCENE"}
                        </span>
                        <div className="scene-caption">
                          <span>STILLNESS, REIMAGINED</span>
                          <p>
                            {imageUrl
                              ? "A new perspective."
                              : "Some moments deserve to move."}
                          </p>
                        </div>
                      </div>
                    )}
                    {active && (
                      <div className="render-overlay">
                        <div className="render-orbit">
                          <LoaderCircle size={30} className="spin" />
                        </div>
                        <h3>
                          {job?.status === "queued"
                            ? "Your scene is up next."
                            : "A little motion is on its way."}
                        </h3>
                        <p>
                          {submitting
                            ? runtime.standalone
                              ? "Opening your starting frame"
                              : "Uploading your starting frame"
                            : job?.engine === "ai"
                              ? "Generating subject movement with xAI, then exporting 1080p. This may take several minutes."
                              : `${Math.round(job?.progress || 0)}% rendered`}
                        </p>
                        <div className="progress-track">
                          <span style={{ width: `${job?.progress || 0}%` }} />
                        </div>
                        {job?.engine === "ai" && (
                          <p className="ai-cancel-note">
                            xAI does not cancel submitted jobs. Stopping here
                            does not stop the remote job or billing.
                          </p>
                        )}
                        {job && (
                          <button
                            className="text-button"
                            onClick={() => removeVideo(job)}
                          >
                            {job.engine === "ai"
                              ? "Stop waiting and remove"
                              : "Cancel rendering"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="preview-toolbar">
                    <div>
                      <span className="video-dot" />
                      <span>{completed ? job.duration : duration} sec</span>
                      <span className="toolbar-separator" />{" "}
                      <span>
                        {formats.find((item) => item.id === format)?.ratio}
                      </span>
                      <span className="toolbar-separator" />
                      <span>
                        {completed ? Math.min(job.width, job.height) : 1080}p
                        {job?.upscaled ? " (upscaled)" : ""}
                      </span>
                    </div>
                    {completed ? (
                      <div className="preview-actions">
                        {job.extendable !== false &&
                          job.engine !== "ai" &&
                          job.duration + 3 <= MAX_TOTAL_DURATION && (
                            <button
                              className="extend-button"
                              onClick={() => openExtension(job)}
                            >
                              <Plus size={15} /> Extend video
                            </button>
                          )}
                        <a
                          className="download-button"
                          href={job.fileUrl!}
                          download={
                            job.filename ||
                            `vanta-${job.id}.${job.extension || "mp4"}`
                          }
                        >
                          <ArrowDownToLine size={15} /> Download
                        </a>
                      </div>
                    ) : (
                      <button
                        className="preview-motion-button"
                        disabled={!file || active || engine === "ai"}
                        onClick={() => setPreviewMotion((value) => !value)}
                      >
                        <ArrowLeftRight size={15} />
                        {previewMotion ? "Stop preview" : "Preview motion"}
                      </button>
                    )}
                  </div>
                  <div className="preview-info">
                    <span className="info-icon">
                      <Film size={21} />
                    </span>
                    <div>
                      <h3>
                        {completed
                          ? "Your moment, in motion."
                          : engine === "ai"
                            ? "Two references. One moving scene."
                            : "Small movement. A whole new feeling."}
                      </h3>
                      <p>
                        {completed
                          ? `Your ${(job?.extension || "mp4").toUpperCase()} is ready in My videos. Download it and make it yours.`
                          : engine === "ai"
                            ? "Grok receives every reference together and follows the complete scene prompt. The model creates new motion; reference mode renders at 720p, then the server exports an explicitly upscaled 1080p video."
                            : "Add a cinematic pan or zoom to your photo. Your image stays the star — no AI subject animation or invented frames."}
                      </p>
                    </div>
                  </div>
                  <div className="workflow">
                    <div>
                      <span>1</span>
                      <strong>Start with an image</strong>
                      <p>A photo, an artwork, an idea.</p>
                    </div>
                    <ArrowRight size={15} />
                    <div>
                      <span>2</span>
                      <strong>Find your movement</strong>
                      <p>Choose a different perspective.</p>
                    </div>
                    <ArrowRight size={15} />
                    <div>
                      <span>3</span>
                      <strong>Make it yours</strong>
                      <p>Export and share your scene.</p>
                    </div>
                  </div>
                </section>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    <span /> YOUR CREATIVE COLLECTION
                  </div>
                  <h1>
                    Moments in motion<span>.</span>
                  </h1>
                  <p>Every scene you’ve made, ready for its next chapter.</p>
                </div>
                <button className="secondary-button" onClick={newVideo}>
                  <Plus size={16} /> New video
                </button>
              </div>
              {videos.length ? (
                <div className="video-grid">
                  {videos.map((video) => (
                    <article className="video-card" key={video.id}>
                      <video
                        src={video.fileUrl!}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label={`Video created ${new Date(video.createdAt).toLocaleString()}`}
                      />
                      <div className="video-card-details">
                        <div>
                          <h3>
                            {video.prompt ||
                              motions.find((item) => item.id === video.motion)
                                ?.title ||
                              "Camera motion"}
                          </h3>
                          <p>
                            {video.duration}s · {video.width} × {video.height} ·{" "}
                            {new Date(video.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        <a
                          className="icon-button"
                          href={video.fileUrl!}
                          download={
                            video.filename ||
                            `vanta-${video.id}.${video.extension || "mp4"}`
                          }
                          aria-label="Download video"
                        >
                          <ArrowDownToLine size={17} />
                        </a>
                        {video.extendable !== false &&
                          video.engine !== "ai" &&
                          video.duration + 3 <= MAX_TOTAL_DURATION && (
                            <button
                              className="icon-button"
                              aria-label="Extend saved video"
                              disabled={!!active}
                              onClick={() => openExtension(video)}
                            >
                              <Plus size={17} />
                            </button>
                          )}
                        <button
                          className="icon-button danger"
                          aria-label="Delete video"
                          onClick={() => removeVideo(video)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-library">
                  <Layers3 size={40} />
                  <h2>Your first scene is waiting.</h2>
                  <p>Create a video and it will be saved here.</p>
                  <button className="secondary-button" onClick={newVideo}>
                    Create your first video <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
          {error && (
            <div className="error-message" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <footer>
            <span>
              VANTA ONE <i /> IMAGINATION IN MOTION
            </span>
            <span>
              <ShieldCheck size={12} />{" "}
              {runtime.standalone
                ? "Your videos stay in this browser. Download to keep."
                : engine === "ai"
                  ? "AI scenes send your images and prompt to xAI."
                  : "Your camera videos stay on this server."}
            </span>
          </footer>
        </main>
      </div>
      {extensionTarget && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!active) setExtensionTarget(null);
          }}
        >
          <section
            ref={extensionModal}
            className="help-modal extension-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="extension-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              disabled={!!active}
              aria-label="Close extension popup"
              onClick={() => setExtensionTarget(null)}
            >
              <X size={20} />
            </button>
            <span className="eyebrow">YOUR VIDEO IS READY</span>
            <h2 id="extension-title">Keep the story going?</h2>
            <p>
              Your {extensionTarget.duration}-second video is saved. Add another
              scene to make a longer video; your original stays available.
            </p>
            <label className="field-label" htmlFor="extension-prompt">
              Extension prompt
            </label>
            <textarea
              id="extension-prompt"
              className="prompt-input"
              rows={2}
              maxLength={MAX_PROMPT_LENGTH}
              value={extensionPrompt}
              disabled={!!active}
              onChange={(event) => setExtensionPrompt(event.target.value)}
              placeholder="Continue with a slow zoom out…"
            />
            <p className="prompt-explanation">
              Use zoom in, zoom out, pan left, pan right, or still to direct the
              added scene.
            </p>
            <span className="field-label">Add images (optional)</span>
            <ImageSelector
              files={extensionFiles}
              onAdd={selectExtensionFiles}
              onChange={(next) => {
                extensionVersion.current++;
                setExtensionFiles(next);
              }}
              disabled={!!active}
              loading={loadingExtension}
              label="Add extension images"
            />
            <p className="prompt-explanation">
              Leave empty to continue from the final frame, or add up to six
              images in order.
            </p>
            <span className="field-label">Extend by</span>
            <div className="segmented extension-duration">
              {[3, 5, 10].map((seconds) => (
                <button
                  key={seconds}
                  disabled={
                    !!active ||
                    extensionTarget.duration + seconds > MAX_TOTAL_DURATION
                  }
                  className={extensionDuration === seconds ? "active" : ""}
                  onClick={() => setExtensionDuration(seconds)}
                >
                  +{seconds}s
                </button>
              ))}
            </div>
            <p className="extension-total">
              New length:{" "}
              <strong>
                {extensionTarget.duration + extensionDuration} seconds
              </strong>
              <span>Up to {MAX_TOTAL_DURATION}s total</span>
            </p>
            <button
              className="generate-button"
              disabled={!!active || loadingExtension}
              onClick={extendVideo}
            >
              {submitting ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <Plus size={17} />
              )}
              <span>
                {submitting ? "Starting extension…" : "Generate extension"}
              </span>
              <ArrowRight size={17} />
            </button>
            <div className="extension-bottom">
              <button
                className="text-button"
                disabled={!!active}
                onClick={() => setExtensionTarget(null)}
              >
                Not now
              </button>
              <a
                className="download-button"
                href={extensionTarget.fileUrl!}
                download={
                  extensionTarget.filename ||
                  `vanta-${extensionTarget.id}.${extensionTarget.extension || "mp4"}`
                }
              >
                <ArrowDownToLine size={15} /> Download current video
              </a>
            </div>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            ref={modal}
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button modal-close"
              onClick={() => setHelp(false)}
              aria-label="Close help"
            >
              <X size={20} />
            </button>
            <span className="eyebrow">A LITTLE CREATIVE DIRECTION</span>
            <h2 id="help-title">From still to scene.</h2>
            <p>
              {runtime.standalone
                ? "Select Camera sequence to animate one to six JPG, PNG, or WebP images in your browser. MP4 is preferred; browsers without MP4 recording use WebM. Real AI subject movement requires the server version and an xAI key."
                : "Select AI scene to combine one to three reference images with your complete scene prompt using Grok. Configure XAI_API_KEY on the server first. Camera sequence animates one to six images with FFmpeg and supports extensions."}
            </p>
            <div className="help-detail">
              <Clock3 size={19} />
              <p>
                Pick 3, 5, or 10 seconds. Landscape and portrait exports use a
                1080-pixel short edge; square uses 1080 × 1080. Grok reference
                scenes are generated at 720p and upscaled to 1080p.
              </p>
            </div>
            <div className="help-detail">
              <ShieldCheck size={19} />
              <p>
                AI scenes send your images and prompt to xAI and use your xAI
                credits. Camera sequence needs no API key and creates silent
                pan-and-zoom video. Stopping an AI wait does not cancel the
                provider’s generation or its charges.
              </p>
            </div>
            <p className="muted">
              {runtime.standalone
                ? "Keep this tab visible while recording. My videos uses this browser’s storage, which may be cleared or unavailable in private browsing. Download videos you want to keep. Camera animation does not create AI subject movement."
                : "My videos keeps your 50 most recent exports on this server. Older videos are removed automatically. Download the ones you want to keep. This is a personal workspace."}
            </p>
            <button className="secondary-button" onClick={() => setHelp(false)}>
              <ArrowLeft size={15} /> Back to creating
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
