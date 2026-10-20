import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import { MAX_IMAGES } from "../shared/prompt.js";

export async function validateImages(candidates: File[], existing: File[]) {
  if (existing.length + candidates.length > MAX_IMAGES)
    throw new Error(
      `Choose up to ${MAX_IMAGES} images per sequence. Remove an image before adding another.`,
    );
  if (
    [...existing, ...candidates].reduce((total, file) => total + file.size, 0) >
    60 * 1024 * 1024
  )
    throw new Error("Keep the combined image size under 60 MB.");
  for (const file of candidates) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      throw new Error("Choose a JPG, PNG, or WebP image.");
    if (file.size > 20 * 1024 * 1024)
      throw new Error("Each image must be smaller than 20 MB.");
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
    } catch {
      throw new Error(`Could not open ${file.name}. Try another image.`);
    }
    const valid =
      bitmap.width >= 2 &&
      bitmap.height >= 2 &&
      bitmap.width * bitmap.height <= 40_000_000 &&
      Math.max(bitmap.width, bitmap.height) <= 16384;
    bitmap.close();
    if (!valid)
      throw new Error(
        "Use images between 2 and 16,384 pixels per side, up to 40 megapixels.",
      );
  }
  return [...existing, ...candidates];
}

function Thumbnail({ file, index }: { file: File; index: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <img
      src={url || undefined}
      alt={index === 0 ? "Your starting frame" : `Selected image ${index + 1}`}
    />
  );
}

export default function ImageSelector({
  files,
  onAdd,
  onChange,
  disabled,
  loading,
  label = "Add images",
  maxImages = MAX_IMAGES,
  references = false,
}: {
  files: File[];
  onAdd: (files: File[]) => void;
  onChange: (files: File[]) => void;
  disabled: boolean;
  loading: boolean;
  label?: string;
  maxImages?: number;
  references?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const blocked = disabled || loading;
  const reorder = (index: number, direction: number) => {
    const next = [...files];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange(next);
  };
  return (
    <div className="image-selector">
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        aria-label={label}
        hidden
        disabled={blocked}
        onChange={(event) => {
          onAdd(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
      <div
        className={`upload-area ${dragging ? "dragging" : ""} ${files.length ? "has-storyboard" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!blocked) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!blocked) onAdd(Array.from(event.dataTransfer.files));
        }}
      >
        {files.length ? (
          <div className="storyboard-grid">
            {files.map((file, index) => (
              <div
                className="storyboard-image"
                key={`${index}-${file.name}-${file.lastModified}`}
              >
                <Thumbnail file={file} index={index} />
                <span className="image-number">{index + 1}</span>
                <button
                  className="remove-image"
                  disabled={blocked}
                  aria-label={`Remove image ${index + 1}`}
                  onClick={() => onChange(files.filter((_, i) => i !== index))}
                >
                  <X size={13} />
                </button>
                {!references && (
                  <div className="reorder-images">
                    <button
                      disabled={blocked || index === 0}
                      aria-label={`Move image ${index + 1} earlier`}
                      onClick={() => reorder(index, -1)}
                    >
                      <ArrowLeft size={12} />
                    </button>
                    <button
                      disabled={blocked || index === files.length - 1}
                      aria-label={`Move image ${index + 1} later`}
                      onClick={() => reorder(index, 1)}
                    >
                      <ArrowRight size={12} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {files.length < maxImages && (
              <button
                className="add-storyboard-image"
                disabled={blocked}
                onClick={() => input.current?.click()}
                aria-label={label}
              >
                <Plus size={22} />
                <span>Add image</span>
              </button>
            )}
          </div>
        ) : (
          <button
            className="upload-action"
            disabled={blocked}
            onClick={() => input.current?.click()}
          >
            <span className="upload-icon">
              {loading ? (
                <LoaderCircle className="spin" size={25} />
              ) : (
                <ImagePlus size={26} />
              )}
            </span>
            <strong>
              {loading ? "Opening your images…" : "Drop your images here"}
            </strong>
            <span>
              or <em>browse files</em> to get started
            </span>
            <small>
              1–{maxImages} {references ? "references" : "images"} · 20 MB each
              · 60 MB combined
            </small>
          </button>
        )}
      </div>
      <p className="storyboard-hint">
        {files.length
          ? references
            ? `${files.length} of ${maxImages} references · Combined into one AI scene`
            : `${files.length} of ${maxImages} images · Plays in this order · Use arrows to reorder`
          : references
            ? "Add reference images for one coherent scene."
            : "Add one image or build a sequence with three or more."}
      </p>
    </div>
  );
}
