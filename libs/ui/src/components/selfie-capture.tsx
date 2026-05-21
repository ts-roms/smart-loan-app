import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

type Status = "idle" | "requesting" | "streaming" | "captured" | "error";

export interface SelfieCaptureProps {
  /** Controls dialog visibility. */
  open: boolean;
  /** Fires when the dialog is dismissed (cancel, ESC, capture confirmed). */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the captured image as a JPEG `File` ready to upload. The
   * file is named `selfie-<timestamp>.jpg` so the server can default a
   * sensible filename. The component closes itself after the callback
   * fires — the caller doesn't need to call `onOpenChange(false)`.
   */
  onCapture: (file: File) => void | Promise<void>;
  /**
   * Called when the user explicitly chooses to upload a file from disk
   * instead of using the camera (or when no camera is available). If
   * omitted, the "Choose a file instead" fallback is hidden.
   */
  onFallbackPick?: () => void;
  /**
   * Whether the parent is busy persisting the captured photo (e.g. an
   * upload mutation is pending). The component disables actions while
   * true and shows a spinner on the confirm button.
   */
  isBusy?: boolean;
  /**
   * Constraint passed to getUserMedia. Defaults to the user-facing camera
   * (selfie cam on mobile, the webcam on a laptop).
   */
  facingMode?: "user" | "environment";
  /** Override the dialog title. */
  title?: string;
}

/**
 * Camera-driven selfie capture. Requests the device camera via
 * getUserMedia(), shows a live preview, and on "Capture" snaps the
 * current video frame into a JPEG `File` handed off via `onCapture`.
 *
 * UX notes:
 *
 *   * The video preview is horizontally mirrored so the user sees a
 *     mirror image (matches real-world selfie behavior). The captured
 *     image is NOT mirrored — we want the actual scene captured for
 *     face-match against ID documents.
 *   * Errors are recoverable. Permission denied + no-camera both render
 *     a friendly error pane with a "Choose a file instead" escape hatch
 *     (if `onFallbackPick` was provided).
 *   * The MediaStream is torn down on dialog close (or unmount) so the
 *     camera indicator turns off — failing to do this is a common
 *     "camera light stays on" bug.
 */
export function SelfieCapture({
  open,
  onOpenChange,
  onCapture,
  onFallbackPick,
  isBusy = false,
  facingMode = "user",
  title = "Take selfie",
}: SelfieCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // Hold the captured photo locally so the user can preview + retake
  // before committing. Cleared on retake / close.
  const [snapshot, setSnapshot] = useState<{
    blob: Blob;
    dataUrl: string;
  } | null>(null);

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startStream = useCallback(async () => {
    setStatus("requesting");
    setError(null);
    setSnapshot(null);

    // Belt-and-suspenders for non-secure contexts. Browsers block
    // getUserMedia outside HTTPS / localhost; surface that clearly.
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError(
        "Camera API is not available in this browser. Try an updated Chrome / Firefox / Safari over HTTPS.",
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // play() can reject on autoplay policies — swallow it; the
        // video element's `autoPlay` attribute usually carries us
        // through, and even if not, the user can press Capture once
        // the static still appears.
        await videoRef.current.play().catch(() => {});
      }
      setStatus("streaming");
    } catch (err) {
      setStatus("error");
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError(
          "Camera permission was denied. Allow camera access in your browser settings and try again.",
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found on this device.");
      } else if (name === "NotReadableError") {
        setError(
          "Another application is using the camera. Close it and try again.",
        );
      } else {
        setError((err as Error).message ?? "Failed to open the camera.");
      }
    }
  }, [facingMode]);

  // Start the stream whenever the dialog opens, tear it down whenever it
  // closes. Capture is also implicitly a "stop streaming" event but we
  // wait until close to release the camera in case the user retakes.
  useEffect(() => {
    if (open) {
      void startStream();
    } else {
      stopStream();
      setStatus("idle");
      setError(null);
      setSnapshot(null);
    }
    // Cleanup on unmount — important for SPA navigation while open.
    return () => stopStream();
  }, [open, startStream, stopStream]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    // Use a one-shot canvas (not attached to the DOM) — we only need
    // it to grab the current frame as an encoded blob.
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        setSnapshot({ blob, dataUrl });
        setStatus("captured");
      },
      "image/jpeg",
      0.9,
    );
  };

  const retake = () => {
    setSnapshot(null);
    setStatus("streaming");
  };

  const confirm = async () => {
    if (!snapshot) return;
    const file = new File([snapshot.blob], `selfie-${Date.now()}.jpg`, {
      type: "image/jpeg",
    });
    await onCapture(file);
    // Defer close — parent likely tracks upload state and will close us
    // via onOpenChange(false) after the mutation resolves. But also
    // close ourselves so a non-async caller still gets dismissed.
    if (!isBusy) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-sky-300" />
            {title}
          </DialogTitle>
        </DialogHeader>

        {/*
          Single 16:9 viewport that hosts either the live video or the
          captured still. Keeping it in one box avoids layout-shift when
          the user toggles between "Capture" and "Retake".
        */}
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-white/10 bg-black">
          {/* Live preview */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            // Mirror the live preview for selfie ergonomics. The captured
            // canvas is intentionally NOT mirrored so the saved photo
            // matches reality.
            className={cn(
              "h-full w-full object-cover",
              facingMode === "user" && "scale-x-[-1]",
              status === "captured" && "invisible",
            )}
          />
          {/* Captured still */}
          {snapshot && (
            <img
              src={snapshot.dataUrl}
              alt="captured selfie preview"
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {/* State overlay — requesting / error */}
          {status === "requesting" && (
            <Overlay>
              <Loader2 className="h-6 w-6 animate-spin text-sky-300" />
              <span>Opening camera…</span>
            </Overlay>
          )}
          {status === "error" && (
            <Overlay tone="error">
              <AlertCircle className="h-6 w-6 text-rose-300" />
              <span className="max-w-sm">{error}</span>
            </Overlay>
          )}
          {/* Captured badge */}
          {status === "captured" && (
            <div className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 px-2 py-1 text-[10px] uppercase tracking-wider text-emerald-300">
              <CheckCircle2 className="h-3 w-3" />
              Captured
            </div>
          )}
        </div>

        <p className="text-[11px] text-white/45">
          Position your face inside the frame, make sure lighting is even, and
          remove sunglasses or anything covering your face.
        </p>

        <DialogFooter className="flex flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {onFallbackPick && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  // Defer so the dialog tear-down + stream stop run
                  // before the file dialog opens.
                  setTimeout(() => onFallbackPick(), 0);
                }}
                disabled={isBusy}
              >
                <Upload className="h-3 w-3" />
                Choose a file instead
              </Button>
            )}
            {status === "error" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void startStream()}
              >
                <RotateCcw className="h-3 w-3" />
                Retry
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isBusy}
            >
              <X className="h-4 w-4" />
              Cancel
            </Button>
            {status === "captured" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={retake}
                  disabled={isBusy}
                >
                  <RotateCcw className="h-4 w-4" />
                  Retake
                </Button>
                <Button type="button" onClick={confirm} disabled={isBusy}>
                  {isBusy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      Use this photo
                    </>
                  )}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                onClick={capture}
                disabled={status !== "streaming"}
              >
                <Camera className="h-4 w-4" />
                Capture
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Overlay({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "error";
}) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-center px-4",
        tone === "info"
          ? "bg-black/40 text-white/80"
          : "bg-black/70 text-white",
      )}
    >
      {children}
    </div>
  );
}
