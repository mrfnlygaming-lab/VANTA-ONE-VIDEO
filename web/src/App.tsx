import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { request as api, ApiError, runtime } from "./runtime";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Clock3,
  Film,
  ImagePlus,
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
  Upload,
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
  motion: Motion;
  width: number;
  height: number;
  createdAt: string;
  fileUrl: string | null;
  error: string | null;
  extension?: string;
  filename?: string;
  persisted?: boolean;
  warning?: string | null;
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
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion>("zoom-in");
  const [format, setFormat] = useState<Format>("landscape");
  const [duration, setDuration] = useState(5);
  const [job, setJob] = useState<Video | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(false);
  const [exportExtension, setExportExtension] = useState("mp4");
  const [previewMotion, setPreviewMotion] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const modal = useRef<HTMLElement>(null);
  const sourceVersion = useRef(0);
  const active =
    submitting || job?.status === "queued" || job?.status === "processing";
  const selectedMotion = motions.find((item) => item.id === motion)!;
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
    api<{ extension?: string; storageWarning?: string }>("/api/capabilities")
      .then((info) => {
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

  async function selectFile(candidate?: File) {
    if (!candidate || active) return;
    const version = ++sourceVersion.current;
    setError(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(candidate.type)) {
      setError("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (candidate.size > 20 * 1024 * 1024) {
      setError("This image is too large. Choose one smaller than 20 MB.");
      return;
    }
    setLoadingImage(true);
    try {
      const image = await createImageBitmap(candidate);
      const tooLarge =
        image.width * image.height > 40_000_000 ||
        Math.max(image.width, image.height) > 16384;
      image.close();
      if (tooLarge)
        throw new Error(
          "Choose an image under 40 megapixels and 16,384 pixels per side.",
        );
      if (version === sourceVersion.current) {
        setFile(candidate);
        setJob(null);
        setPreviewMotion(false);
      }
    } catch (err) {
      if (version === sourceVersion.current)
        setError(
          err instanceof Error
            ? err.message
            : "This image could not be opened. Try another file.",
        );
    } finally {
      if (version === sourceVersion.current) setLoadingImage(false);
    }
  }

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
      await selectFile(
        new File([blob], "Alpine-still.png", { type: "image/png" }),
      );
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
    setSubmitting(true);
    setError(null);
    setPreviewMotion(false);
    try {
      const data = new FormData();
      data.append("image", file);
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

  async function removeVideo(video: Video) {
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      if (job?.id === video.id) setJob(null);
      await refreshVideos();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not remove the video.",
      );
    }
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void selectFile(event.dataTransfer.files[0]);
  }
  function upload(event: ChangeEvent<HTMLInputElement>) {
    void selectFile(event.target.files?.[0]);
    event.target.value = "";
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
                    Give your image a little life<span>.</span>
                  </h1>
                  <p>Start with a still. Create a scene worth watching.</p>
                </div>
                <span className="version-tag">
                  <Sparkles size={13} /> Image to video
                </span>
              </div>
              <div className="studio-grid">
                <section className="settings-panel" aria-label="Video settings">
                  <div className="section-title">
                    <h2>
                      <span className="step">01</span> Starting frame
                    </h2>
                    <span className="small-label">JPG, PNG, WEBP</span>
                  </div>
                  <input
                    ref={input}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    onChange={upload}
                  />
                  <div
                    className={`upload-area ${dragging ? "dragging" : ""} ${imageUrl ? "has-image" : ""}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (!active) setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={drop}
                  >
                    {imageUrl ? (
                      <>
                        <img src={imageUrl} alt="Your starting frame" />
                        <div className="uploaded-overlay">
                          <span>
                            <Check size={13} /> Image ready
                          </span>
                          <button
                            className="icon-button"
                            disabled={active}
                            aria-label="Remove image"
                            onClick={() => {
                              sourceVersion.current++;
                              setFile(null);
                              setJob(null);
                            }}
                          >
                            <X size={15} />
                          </button>
                        </div>
                        <button
                          className="replace-image"
                          disabled={active}
                          onClick={() => input.current?.click()}
                        >
                          <Upload size={13} /> Replace image
                        </button>
                      </>
                    ) : (
                      <button
                        className="upload-action"
                        disabled={active || loadingImage}
                        onClick={() => input.current?.click()}
                      >
                        <span className="upload-icon">
                          {loadingImage ? (
                            <LoaderCircle className="spin" size={25} />
                          ) : (
                            <ImagePlus size={26} />
                          )}
                        </span>
                        <strong>
                          {loadingImage
                            ? "Opening your image…"
                            : "Drop your image here"}
                        </strong>
                        <span>
                          or <em>browse files</em> to get started
                        </span>
                        <small>
                          Up to 20 MB · One image, endless perspectives
                        </small>
                      </button>
                    )}
                  </div>
                  <button
                    className="example-button"
                    disabled={active || loadingImage}
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
                      <span className="step">02</span> Make it move
                    </h2>
                    <SlidersHorizontal size={15} className="muted" />
                  </div>
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
                      value={motion}
                      disabled={active}
                      onChange={(event) => {
                        setMotion(event.target.value as Motion);
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
                  <div className="field-row">
                    <div>
                      <span className="field-label">Duration</span>
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
                        720p<span>HD</span>
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
                    <span>No credits. No API key. Just your creativity.</span>
                  </div>
                  <button
                    className="generate-button"
                    disabled={!file || active || loadingImage || !online}
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
                          : "Generate video"}
                    </span>
                    {!active && <ArrowRight size={18} />}
                  </button>
                  <p className="settings-footnote">
                    Camera animation · 24 fps · {exportExtension.toUpperCase()}{" "}
                    export
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
                        className={`scene-frame ${previewMotion ? `animate ${motion}` : ""}`}
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
                            : `${Math.round(job?.progress || 0)}% rendered`}
                        </p>
                        <div className="progress-track">
                          <span style={{ width: `${job?.progress || 0}%` }} />
                        </div>
                        {job && (
                          <button
                            className="text-button"
                            onClick={() => removeVideo(job)}
                          >
                            Cancel rendering
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="preview-toolbar">
                    <div>
                      <span className="video-dot" />
                      <span>{duration} sec</span>
                      <span className="toolbar-separator" />{" "}
                      <span>
                        {formats.find((item) => item.id === format)?.ratio}
                      </span>
                      <span className="toolbar-separator" />
                      <span>HD 720p</span>
                    </div>
                    {completed ? (
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
                    ) : (
                      <button
                        className="preview-motion-button"
                        disabled={!file || active}
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
                          : "Small movement. A whole new feeling."}
                      </h3>
                      <p>
                        {completed
                          ? `Your ${(job?.extension || "mp4").toUpperCase()} is ready in My videos. Download it and make it yours.`
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
                            {motions.find((item) => item.id === video.motion)
                              ?.title || "Camera motion"}
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
                : "Your 50 most recent videos stay on this server"}
            </span>
          </footer>
        </main>
      </div>
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
                ? "Choose a JPG, PNG, or WebP image, select a camera movement, and create a video directly in your browser. No server or installation is needed. MP4 is preferred; browsers without MP4 recording use WebM."
                : "Upload a JPG, PNG, or WebP image, choose a camera movement, and generate a real H.264 MP4. Rendering happens on this app’s server using FFmpeg."}
            </p>
            <div className="help-detail">
              <Clock3 size={19} />
              <p>
                Pick 3, 5, or 10 seconds at 24 fps. Landscape and portrait use a
                720-pixel short edge; square exports at 720 × 720.
              </p>
            </div>
            <div className="help-detail">
              <ShieldCheck size={19} />
              <p>
                No API keys or external AI service. This creates cinematic
                pan-and-zoom motion, rather than new movement within your
                subjects. Videos are silent.
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
