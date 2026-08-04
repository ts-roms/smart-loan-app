import { useUpload, type UploadSubdir } from "@loan/api-client";
import { Button, SelfieCapture, useToast } from "@loan/ui";
import { Camera, Upload, X } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

/**
 * Reusable upload widget. Calls /uploads-api/<subdir>, returns the public
 * URL to the parent via `onUploaded`. Use the lower-level useUpload hook
 * directly when you need custom UI (camera capture, drag-drop, etc.).
 *
 * When `capture="user"` is set (selfie use case), the primary action
 * becomes "Open camera" which opens a live-preview dialog backed by
 * getUserMedia(). The native file picker is kept as a secondary
 * fallback for desktop users without a working webcam.
 */
export function FileUpload({
  subdir,
  value,
  onUploaded,
  onClear,
  accept = "image/*,application/pdf",
  label = "Upload",
  capture,
}: {
  subdir: UploadSubdir;
  value?: string | null;
  onUploaded: (url: string) => void;
  onClear?: () => void;
  accept?: string;
  label?: string;
  /**
   * `'user'` flips this widget into selfie-capture mode (live camera
   * preview via getUserMedia). `'environment'` does the same for the
   * rear camera. On mobile, both also hint the native picker to open
   * the camera directly.
   */
  capture?: "user" | "environment";
}) {
  const upload = useUpload();
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);

  const onChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const result = await upload.mutateAsync({ file: f, subdir });
      onUploaded(result.url);
    } catch (err) {
      toast.error((err as Error).message ?? "Upload failed");
    } finally {
      if (ref.current) ref.current.value = "";
    }
  };

  const onCameraCapture = async (file: File) => {
    try {
      const result = await upload.mutateAsync({ file, subdir });
      onUploaded(result.url);
      setCameraOpen(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Upload failed");
    }
  };

  if (value) {
    const isImage = /\.(jpe?g|png|webp|heic)$/i.test(value);
    return (
      <div className="flex items-center gap-2">
        {isImage ? (
          <a href={value} target="_blank" rel="noopener noreferrer">
            <img
              src={value}
              alt="upload preview"
              className="h-16 w-16 rounded-md border border-default object-cover"
            />
          </a>
        ) : (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-info hover:underline"
          >
            View file
          </a>
        )}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-fg-subtle hover:text-danger"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  // Camera mode: live capture is the primary CTA, with file upload as
  // a fallback for users whose camera permission was denied or who
  // simply prefer to attach an existing photo.
  if (capture === "user" || capture === "environment") {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={ref}
          type="file"
          accept={accept}
          capture={capture}
          onChange={onChange}
          className="hidden"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => setCameraOpen(true)}
          disabled={upload.isPending}
        >
          <Camera className="h-3 w-3" />
          {upload.isPending ? "Uploading…" : "Open camera"}
        </Button>
        <button
          type="button"
          onClick={() => ref.current?.click()}
          disabled={upload.isPending}
          className="text-xs text-fg-muted hover:text-info underline-offset-2 hover:underline disabled:opacity-50"
        >
          or upload a file
        </button>

        <SelfieCapture
          open={cameraOpen}
          onOpenChange={setCameraOpen}
          onCapture={onCameraCapture}
          onFallbackPick={() => ref.current?.click()}
          facingMode={capture}
          isBusy={upload.isPending}
          title={capture === "user" ? "Take selfie" : "Take photo"}
        />
      </div>
    );
  }

  // Default: classic file picker.
  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept={accept}
        capture={capture}
        onChange={onChange}
        className="hidden"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => ref.current?.click()}
        disabled={upload.isPending}
      >
        <Upload className="h-3 w-3" />
        {upload.isPending ? "Uploading…" : label}
      </Button>
    </div>
  );
}
