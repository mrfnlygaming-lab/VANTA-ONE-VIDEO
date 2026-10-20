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
type AiBackend = "vanta-motion";
type SoundMode = "silent" | "auto";
type SpeedMode = "turbo" | "balanced" | "quality";
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
  aiBackend?: AiBackend;
  hasAudio?: boolean;
  audioEngine?: string | null;
  soundMode?: SoundMode;
  speedMode?: SpeedMode;
  stage?: string;
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
  const [aiBackend] = useState<AiBackend>("vanta-motion");
  const [vantaAvailable, setVantaAvailable] = useState(false);
  const [checkingAi, setCheckingAi] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [backgroundIndex, setBackgroundIndex] = useState(0);
  const keepIdentity = true;
  const keepOutfit = true;
  const [soundMode, setSoundMode] = useState<SoundMode>("silent");
  const [speedMode, setSpeedMode] = useState<SpeedMode>("turbo");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion>("zoom-in");
  const [format, setFormat] = useState<Format>("landscape");
  const [duration, setDuration] = useState(3);
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
  const aiAvailable = vantaAvailable;
  const resolvedMotion =
    engine === "camera" ? promptMotion(prompt) || motion : motion;
  const selectedMotion = motions.find((item) => item.id === resolvedMotion)!;
  const completed = job?.status === "completed" && job.fileUrl;

  const refreshVideos = () =>
    api<{ videos: Video[] }>("/api/videos").then((data) =>
      setVideos(data.videos),
    );
  const refreshCapabilities = () =>
    api<{
      extension?: string;
      storageWarning?: string;
      ai?: boolean;
      vantaMotion?: boolean;
      referenceCore?: string;
    }>("/api/capabilities").then((info) => {
      setVantaAvailable(info.vantaMotion === true);
      if (info.extension) setExportExtension(info.extension);
      if (info.storageWarning) setError(info.storageWarning);
      return info;
    });
  async function checkAiSetup() {
    setCheckingAi(true);
    setError(null);
    try {
      const info = await refreshCapabilities();
      if (info.vantaMotion !== true)
        setError(
          "VANTA Motion Core is not ready. Check the existing XZAKUT_TRAINING_NATIVE Wan runtime and trained motion weights.",
        );
    } catch (err) {
      setVantaAvailable(false);
      setError(
        err instanceof Error ? err.message : "Could not check the AI server.",
      );
    } finally {
      setCheckingAi(false);
    }
  }
  useEffect(() => {
    const health = () =>
      api<{ status: string }>("/api/health")
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    void health();
    refreshCapabilities().catch((err) => {
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
      if (engine === "ai")
        throw new Error("VANTA Motion Core is prompt-only while VANTA Reference Core is being trained.");
      const next = await validateImages(candidates, files);
      if (version === sourceVersion.current) {
        setFiles(next);
        if (backgroundIndex >= next.length) setBackgroundIndex(0);
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
    if (active) return;
    if (engine !== "ai" && !file) return;
    if (
      engine === "ai" &&
      (!aiAvailable || !prompt.trim() || files.length > 0)
    ) {
      setError(
        "VANTA Motion Core needs the local trained motion runtime, a scene prompt, and no reference images yet.",
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
      data.append("aiBackend", aiBackend);
      data.append("soundMode", soundMode);
      data.append("speedMode", speedMode);
      data.append("backgroundIndex", String(backgroundIndex));
      data.append("keepIdentity", String(keepIdentity));
      data.append("keepOutfit", String(keepOutfit));
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
                <strong>Offline camera app.</strong> Camera sequences work in
                this file. Real AI scenes require VANTA Motion Core running on the local PC server.
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
                    Choose your starting photo. Describe the action. Create a moving
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
                      AI scene · local GPU
                    </option>
                    <option value="camera">
                      Camera sequence · pan and zoom
                    </option>
                  </select>
                  <p className="prompt-explanation">
                    {engine === "ai"
                      ? "VANTA Motion Core uses our trained local motion stack. No cloud credits and no hidden fallback."
                      : "Play up to six still images in order with camera movement. This mode does not animate subjects."}
                  </p>
                  {engine === "ai" && (
                    <div className="reference-controls">
                      <strong>VANTA Motion Core</strong>
                      <p className="prompt-explanation">
                        Our current trained motion core is prompt-driven. VANTA Reference Core is the next adapter we train so image references return without using another video model.
                      </p>
                    </div>
                  )}
                  {engine === "ai" && !aiAvailable && (
                    <div className="ai-setup-message" role="status">
                      <p>
                        {runtime.standalone
                          ? "This standalone HTML can animate camera movement only. Start the PC server for VANTA Motion Core."
                          : "VANTA Motion Core needs the existing XZAKUT_TRAINING_NATIVE runtime and trained weights on this PC."}
                      </p>
                      <div className="ai-setup-actions">
                        {runtime.standalone && (
                          <a
                            href="https://github.com/mrfnlygaming-lab/VANTA-ONE-VIDEO/archive/refs/heads/codex/vanta-browser-studio.zip"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Download no-credit PC source
                          </a>
                        )}
                        <a
                          href="https://github.com/mrfnlygaming-lab/VANTA-ONE-VIDEO/blob/codex/vanta-browser-studio/web/LOCAL-NO-CREDITS.md"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Set up AI scenes
                        </a>
                        {!runtime.standalone && (
                          <button disabled={checkingAi} onClick={checkAiSetup}>
                            {checkingAi ? "Checking…" : "Check AI setup"}
                          </button>
                        )}
                        <button
                          disabled={!!active}
                          onClick={() => {
                            setEngine("camera");
                            setJob(null);
                            setPreviewMotion(false);
                          }}
                        >
                          Use Camera sequence
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="section-divider" />
                  <div className="section-title">
                    <h2>
                      <span className="step">01</span>{" "}
                      {engine === "ai" ? "VANTA Motion Core" : "Your images"}
                    </h2>
                    <span className="small-label">
                      {engine === "ai" ? "OUR TRAINED CORE" : "JPG, PNG, WEBP"}
                    </span>
                  </div>
                  {engine === "ai" ? (
                    <div className="reference-controls">
                      <strong>Prompt-driven generation</strong>
                      <p className="prompt-explanation">
                        Reference images are intentionally disabled until VANTA Reference Core is trained. We are not substituting another video model.
                      </p>
                    </div>
                  ) : (
                    <>
                      <ImageSelector
                        files={files}
                        maxImages={6}
                        references={false}
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
                        disabled={active || loadingImage || files.length >= 6}
                        onClick={useExample}
                      >
                        <img src={runtime.exampleImage} alt="" />
                        <span>
                          No image handy? <strong>Try an example</strong>
                        </span>
                        <ArrowUpRight size={15} />
                      </button>
                    </>
                  )}
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
                        ? "Describe the full VANTA motion scene, physical actions, camera behavior, pacing, lighting, and environment…"
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

                  <p className="prompt-explanation">
                    {engine === "ai"
                      ? "This uses VANTA Motion Core locally. Reference conditioning will return through our own VANTA Reference Core adapter."
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
                  {engine === "ai" && (
                    <>
                      <span className="field-label">Render speed</span>
                      <div className="segmented">
                        {(["turbo", "balanced", "quality"] as SpeedMode[]).map((mode) => (
                          <button
                            key={mode}
                            className={speedMode === mode ? "active" : ""}
                            disabled={active}
                            onClick={() => {
                              setSpeedMode(mode);
                              setJob(null);
                            }}
                          >
                            {mode === "turbo"
                              ? "Turbo"
                              : mode === "balanced"
                                ? "Balanced"
                                : "Quality"}
                          </button>
                        ))}
                      </div>
                      <p className="prompt-explanation">
                        {speedMode === "turbo"
                          ? "Turbo is the fastest stable preset on this 16 GB GPU: 6 diffusion steps, 8 generated FPS, resident motion model, then 24 FPS / 1080p export."
                          : speedMode === "balanced"
                            ? "Balanced uses 8 steps and 12 generated FPS."
                            : "Quality uses 12 steps and the largest internal canvas."}
                      </p>
                    </>
                  )}
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
                  {engine === "ai" && (
                    <>
                      <span className="field-label">Sound</span>
                      <select
                        className="engine-select"
                        value={soundMode}
                        disabled={!!active}
                        onChange={(event) =>
                          setSoundMode(event.target.value as SoundMode)
                        }
                      >
                        <option value="silent">Silent · video only</option>
                        <option value="auto">Auto synced sound · local audio engine</option>
                      </select>
                      <p className="prompt-explanation">
                        Auto sound is designed as a second local pass after the video render so the video and audio models do not fight for VRAM.
                      </p>
                    </>
                  )}
                  <div className="render-note">
                    <ShieldCheck size={15} />
                    <span>
                      {engine === "ai"
                        ? "No credits · No API key · Local GPU AI"
                        : "No credits. No API key. Camera animation only."}
                    </span>
                  </div>
                  <button
                    className="generate-button"
                    disabled={
                      active ||
                      loadingImage ||
                      !online ||
                      (engine !== "ai" && !file) ||
                      (engine === "ai" &&
                        (!aiAvailable ||
                          !prompt.trim() ||
                          files.length > 0))
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
                      ? `VANTA Motion Core · ${speedMode.toUpperCase()} · local GPU → 1080p upscale`
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
                            ? "Starting VANTA Motion Core"
                            : job?.engine === "ai"
                              ? job.stage === "loading-core"
                                ? "Loading the trained motion core into GPU memory…"
                                : job.stage === "generating-frames"
                                  ? `Generating AI frames · ${Math.round(job.progress || 0)}%`
                                  : job.stage === "upscaling"
                                    ? "AI frames are done · building the 1080p export…"
                                    : job.stage === "adding-audio"
                                      ? "Video is done · generating synchronized audio…"
                                      : job.stage === "finalizing"
                                        ? "Finalizing the MP4…"
                                        : `VANTA is working · ${Math.round(job.progress || 0)}%`
                              : `${Math.round(job?.progress || 0)}% rendered`}
                        </p>
                        <div className="progress-track">
                          <span style={{ width: `${job?.progress || 0}%` }} />
                        </div>
                        {job?.engine === "ai" && (
                          <p className="ai-cancel-note">
                            This render runs locally. Cancel it here without any API charges.
                          </p>
                        )}
                        {job && (
                          <button
                            className="text-button"
                            onClick={() => removeVideo(job)}
                          >
                            {job.engine === "ai"
                              ? "Cancel local AI render"
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
                            ? "One photo. A moving scene."
                            : "Small movement. A whole new feeling."}
                      </h3>
                      <p>
                        {completed
                          ? `Your ${(job?.extension || "mp4").toUpperCase()} is ready in My videos. Download it and make it yours.`
                          : engine === "ai"
                            ? "VANTA Motion Core creates new frames on your own GPU. The current core renders below final delivery resolution and upscales the export to 1080p."
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
                  ? "AI scenes run locally on your own GPU."
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
                ? "Select Camera sequence to animate one to six JPG, PNG, or WebP images in your browser. MP4 is preferred; browsers without MP4 recording use WebM. Real AI subject movement requires the PC server with your local VANTA Motion Core model."
                : "Select AI scene to animate one reference image using your local VANTA Motion Core model. No credits or API key are needed. Camera sequence animates up to six ordered photos with FFmpeg and supports extensions."}
            </p>
            <div className="help-detail">
              <Clock3 size={19} />
              <p>
                Pick 3, 5, or 10 seconds. Landscape and portrait exports use a
                1080-pixel short edge; square uses 1080 × 1080. VANTA Motion Core renders locally and upscales to the delivery resolution.
              </p>
            </div>
            <div className="help-detail">
              <ShieldCheck size={19} />
              <p>
                AI scene generation runs locally and uses no credits or API key.
                Camera sequence creates silent pan-and-zoom video. Cancelling a local render stops the local process.
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
