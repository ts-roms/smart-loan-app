import { Badge, Button, FileDropzone, SelfieCapture, useToast } from "@loan/ui";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Loader2,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { useState } from "react";

import { runIdOcr, type ExtractedIdFields } from "../../../lib/id-ocr";

export interface IdOcrCardProps {
  /**
   * Called when the officer clicks "Apply to form" on the extracted
   * fields. The parent decides which fields to honour. Officers can
   * also edit any field manually after applying.
   */
  onApply: (fields: ExtractedIdFields) => void;
}

/**
 * In-browser ID OCR. Drop a gov't ID image, Tesseract.js extracts
 * fields client-side (no pixel data leaves the browser), parent
 * receives the extracted dictionary via `onApply`.
 *
 * Designed for the New Customer dialog but reusable anywhere we want
 * to seed a form from an ID photo. The tesseract.js worker is lazy-
 * loaded so the ~3 MB cost is only paid when an officer actually uses
 * the feature.
 */
export function IdOcrCard({ onApply }: IdOcrCardProps) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    fields: ExtractedIdFields;
    text: string;
    confidence: number;
    previewUrl: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // Camera capture dialog — uses the rear ("environment") camera since
  // the operator is photographing a document, not themselves.
  const [cameraOpen, setCameraOpen] = useState(false);

  const onFiles = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setShowRaw(false);
    // Object URL is fed both to the preview <img> AND to tesseract.
    // Important to revoke when we replace it.
    const url = URL.createObjectURL(f);
    try {
      const r = await runIdOcr(url);
      setResult({ ...r, previewUrl: url });
      // Toast quickly so the user knows the long compute is done.
      toast.success(`OCR complete · confidence ${r.confidence.toFixed(0)}%`);
    } catch (err) {
      URL.revokeObjectURL(url);
      const msg = (err as Error).message ?? "OCR failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border border-sky-400/20 bg-sky-500/[0.04] p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="h-8 w-8 shrink-0 rounded-md border border-sky-400/30 bg-sky-500/10 flex items-center justify-center">
          <Sparkles className="h-4 w-4 text-info" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            Scan ID to pre-fill form
            <Badge variant="muted" className="ml-2 text-[10px]">
              Beta · runs locally
            </Badge>
          </div>
          <p className="text-xs text-fg-muted">
            Drop a clear photo of the customer's gov't ID. We'll extract the
            name, date of birth, and ID number into the form below. The image
            never leaves your browser.
          </p>
        </div>
      </div>

      {!result && !running && (
        <div className="space-y-2">
          <FileDropzone
            accept="image/*"
            maxSize={5 * 1024 * 1024}
            onFiles={onFiles}
            onReject={(reason) => toast.error(reason)}
            label={
              <>
                <span className="font-medium text-info">Drop an ID image</span>
                <span className="text-fg-muted"> or click to browse</span>
              </>
            }
            hint="JPG / PNG / WebP up to 5 MB"
          />
          {/*
            Live camera option — opens SelfieCapture in environment
            (rear-camera) mode since the operator is photographing a
            document, not themselves. The same `onFiles` handler then
            runs OCR on the captured frame.
          */}
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-fg-subtle">
            <span className="flex-1 h-px bg-surface-3" />
            or
            <span className="flex-1 h-px bg-surface-3" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCameraOpen(true)}
            className="w-full"
          >
            <Camera className="h-3 w-3" />
            Take a photo
          </Button>
        </div>
      )}

      {running && (
        <div className="rounded-md border border-default bg-surface-2 p-4 text-center text-xs text-fg-muted flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-info" />
          <span>Running OCR — first run downloads ~3 MB of language data.</span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-danger flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">OCR failed</div>
            <div className="mt-1">{error}</div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="mt-2 text-info hover:underline text-[11px]"
            >
              Try another image
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-3">
            <a
              href={result.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={result.previewUrl}
                alt="ID preview"
                className="rounded border border-default object-cover w-full max-h-[120px]"
              />
            </a>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between flex-wrap gap-1">
                <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
                  Extracted fields
                </span>
                <span className="text-[10px] text-fg-muted font-mono">
                  confidence {result.confidence.toFixed(0)}%
                </span>
              </div>
              <ExtractedField
                label="Full name"
                value={result.fields.fullName}
              />
              <ExtractedField
                label="First name"
                value={result.fields.firstName}
              />
              <ExtractedField
                label="Last name"
                value={result.fields.lastName}
              />
              <ExtractedField
                label="Date of birth"
                value={result.fields.dateOfBirth}
              />
              <ExtractedField
                label="ID number"
                value={result.fields.idNumber}
              />
              <ExtractedField label="Address" value={result.fields.address} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setShowRaw((s) => !s)}
              className="text-[10px] text-info hover:underline"
            >
              {showRaw ? "Hide" : "Show"} raw OCR text
            </button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  URL.revokeObjectURL(result.previewUrl);
                  setResult(null);
                }}
              >
                Try another
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => onApply(result.fields)}
                disabled={!hasAnyField(result.fields)}
              >
                <CheckCircle2 className="h-3 w-3" />
                Apply to form
              </Button>
            </div>
          </div>

          {showRaw && (
            <pre className="rounded border border-default bg-black/40 p-2 text-[10px] text-fg max-h-40 overflow-auto whitespace-pre-wrap font-mono">
              {result.text || "(empty)"}
            </pre>
          )}
        </div>
      )}

      {/*
        Live-camera capture dialog. SelfieCapture handles the
        getUserMedia plumbing + retake/confirm UX; we just receive the
        captured frame as a File and feed it through the same OCR
        pipeline the dropzone uses.
      */}
      <SelfieCapture
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={async (file) => {
          setCameraOpen(false);
          await onFiles([file]);
        }}
        facingMode="environment"
        title="Capture ID photo"
      />
    </div>
  );
}

function ExtractedField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-fg-subtle w-24 shrink-0">{label}</span>
      {value ? (
        <span className="font-mono text-fg truncate" title={value}>
          {value}
        </span>
      ) : (
        <span className="text-fg-subtle italic">
          <ScanLine className="h-3 w-3 inline mr-0.5" />
          not found
        </span>
      )}
    </div>
  );
}

function hasAnyField(f: ExtractedIdFields): boolean {
  return Boolean(
    f.firstName ||
    f.lastName ||
    f.fullName ||
    f.dateOfBirth ||
    f.idNumber ||
    f.address,
  );
}
