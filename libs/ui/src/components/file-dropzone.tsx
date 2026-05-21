import { Upload } from "lucide-react";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";

export interface FileDropzoneProps {
  /**
   * Comma-separated MIME types or extensions, identical to `<input accept>`
   * — e.g. `".csv,text/csv"`. Files dropped that don't match are rejected
   * with `onReject`. If omitted, anything is accepted.
   */
  accept?: string;
  /** Allow multiple files in one drop. Defaults to false. */
  multiple?: boolean;
  /** Maximum file size in bytes — files larger are rejected. */
  maxSize?: number;
  /** Disable interaction (still renders but greyed out). */
  disabled?: boolean;
  /** Called with the selected / dropped files. */
  onFiles: (files: File[]) => void;
  /**
   * Called when a drop / pick is rejected (wrong type, too large, etc.).
   * If omitted, rejections are silently dropped.
   */
  onReject?: (reason: string, file: File) => void;
  /** Override the headline shown in the dropzone. */
  label?: ReactNode;
  /** Helper text shown under the headline. */
  hint?: ReactNode;
  /** Extra classes — useful for sizing the dropzone in its container. */
  className?: string;
}

/**
 * Drag-and-drop file picker. Clicking the zone opens the native file dialog;
 * dragging files over it shows a hover state; on drop the files are fed to
 * `onFiles`. The component is uncontrolled — the parent decides what to do
 * with the files (read as text, upload, etc.).
 *
 * Accept / maxSize validation happens client-side and rejections call
 * `onReject(reason, file)`. The native `<input>` is kept in sync so a
 * keyboard user can tab into the same control.
 */
export function FileDropzone({
  accept,
  multiple = false,
  maxSize,
  disabled = false,
  onFiles,
  onReject,
  label,
  hint,
  className,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [isDragOver, setIsDragOver] = useState(false);
  // Track depth of dragenter/leave so child element transitions don't flicker
  // the highlight off when the cursor crosses a child boundary.
  const dragDepth = useRef(0);

  const accepts = useCallback(
    (file: File): { ok: true } | { ok: false; reason: string } => {
      if (maxSize !== undefined && file.size > maxSize) {
        return {
          ok: false,
          reason: `File is ${formatBytes(file.size)} (max ${formatBytes(maxSize)})`,
        };
      }
      if (!accept) return { ok: true };
      const tokens = accept
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const name = file.name.toLowerCase();
      const mime = file.type.toLowerCase();
      for (const t of tokens) {
        if (t.startsWith(".")) {
          if (name.endsWith(t)) return { ok: true };
        } else if (t.endsWith("/*")) {
          const prefix = t.slice(0, -1); // "image/"
          if (mime.startsWith(prefix)) return { ok: true };
        } else if (mime === t) {
          return { ok: true };
        }
      }
      return {
        ok: false,
        reason: `File type "${file.type || file.name}" is not accepted`,
      };
    },
    [accept, maxSize],
  );

  const handleFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming);
      if (list.length === 0) return;
      const accepted: File[] = [];
      for (const f of multiple ? list : list.slice(0, 1)) {
        const v = accepts(f);
        if (v.ok) {
          accepted.push(f);
        } else if (onReject) {
          onReject(v.reason, f);
        }
      }
      if (accepted.length > 0) onFiles(accepted);
    },
    [accepts, multiple, onFiles, onReject],
  );

  const onDragEnter = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragOver(true);
  };
  const onDragOver = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled) return;
    e.preventDefault();
    // The dropEffect must be set during dragover for the cursor to show
    // the "copy" affordance over the zone. Without this, some browsers
    // fall back to "not allowed" even when we accept the drop.
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    if (disabled) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  return (
    <label
      htmlFor={inputId}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-drag-over={isDragOver || undefined}
      className={cn(
        "group relative flex flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors",
        "border-white/15 bg-white/[0.02] cursor-pointer",
        "hover:border-sky-400/50 hover:bg-white/[0.04]",
        "focus-within:border-sky-400/70 focus-within:bg-white/[0.04]",
        isDragOver && "border-sky-400 bg-sky-500/10",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          // Reset so picking the same file twice still fires onChange.
          e.target.value = "";
        }}
        className="sr-only"
      />
      <Upload
        className={cn(
          "h-5 w-5 transition-colors",
          isDragOver
            ? "text-sky-300"
            : "text-white/55 group-hover:text-sky-300",
        )}
        aria-hidden
      />
      <div className="text-sm text-white/80">
        {label ?? (
          <>
            <span className="font-medium text-sky-300">Click to browse</span>
            <span className="text-white/55"> or drop a file here</span>
          </>
        )}
      </div>
      {hint && <div className="text-[11px] text-white/45">{hint}</div>}
    </label>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
