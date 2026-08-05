import { useSignedUploadUrl } from "@loan/api-client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn,
} from "@loan/ui";
import { ExternalLink, FileText, ImageOff } from "lucide-react";
import { useState } from "react";

/**
 * Preview for an uploaded document.
 *
 * Uploads are same-origin static paths (`/uploads/kyc/<uuid>.png`), so
 * an image renders directly and a PDF embeds. Every surface that
 * showed one of these was rendering a bare "view" link that opened a
 * new tab, which meant an officer deciding whether to approve a KYC
 * submission had to leave the page to see what they were approving.
 *
 * Protected subdirs need a short-lived signature, minted through
 * `useSignedUploadUrl` — `<img src>` can't carry the Bearer token, so
 * it rides in the query string. Callers pass the STORED path; the
 * exchange happens here rather than at every call site.
 *
 * Kind is inferred from the extension rather than a stored MIME type,
 * because the uploads service names files by extension and doesn't
 * persist a content type. An unrecognized extension falls through to
 * the download link instead of guessing — a wrong <img> is a broken
 * icon, which reads as "the upload failed".
 */
export type DocumentKind = "image" | "pdf" | "other";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i;
const PDF_EXT = /\.pdf(\?|#|$)/i;

export function documentKind(url: string): DocumentKind {
  if (IMAGE_EXT.test(url)) return "image";
  if (PDF_EXT.test(url)) return "pdf";
  return "other";
}

/**
 * Small clickable tile. Opens the full preview; falls back to an icon
 * for PDFs and for images that fail to load — a deleted or moved file
 * shouldn't render as a broken-image glyph with no explanation.
 */
export function DocumentThumbnail({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  // Kind comes from the STORED path — the signed URL carries a query
  // string, and the extension test would still match, but reading the
  // stored path keeps the two independent.
  const kind = documentKind(url);
  // Only images need a URL up front — a PDF or unknown type shows an
  // icon until it's opened, so signing every row of a PDF list would
  // be a round-trip per file for nothing.
  const src = useSignedUploadUrl(kind === "image" ? url : null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Preview ${label}`}
        className={cn(
          "h-12 w-12 shrink-0 overflow-hidden rounded border border-default bg-surface-3",
          "flex items-center justify-center text-fg-subtle",
          "hover:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {kind === "image" && !broken && src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : kind === "image" && broken ? (
          <ImageOff className="h-4 w-4" />
        ) : (
          <FileText className="h-4 w-4" />
        )}
      </button>
      {open && (
        <DocumentPreviewDialog
          url={url}
          label={label}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * Plain `<img>` for a stored upload, with the signature exchange done
 * for you. For the cases that want the image itself rather than a
 * thumbnail-plus-modal — signature strips, inline selfies.
 *
 * Renders a same-sized placeholder while the signature is in flight so
 * the surrounding layout doesn't jump when it arrives.
 */
export function SignedImage({
  url,
  alt,
  className,
}: {
  url: string;
  alt: string;
  className?: string;
}) {
  const src = useSignedUploadUrl(url);
  if (!src) {
    return <div className={cn("animate-pulse bg-surface-3", className)} />;
  }
  return <img src={src} alt={alt} className={className} />;
}

/** Full-size preview. Images scale to fit; PDFs embed. */
export function DocumentPreviewDialog({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const kind = documentKind(url);
  const src = useSignedUploadUrl(url);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <div className="rounded border border-default bg-surface-2 overflow-hidden">
          {!src ? (
            <div className="p-6 text-center text-sm text-fg-muted">
              Loading…
            </div>
          ) : kind === "image" && !broken ? (
            <img
              src={src}
              alt={label}
              onError={() => setBroken(true)}
              /* Capped rather than free-scrolling: a phone photo of an
                 ID is often 3000px tall and would push the actions off
                 the dialog. */
              className="max-h-[65vh] w-full object-contain"
            />
          ) : kind === "pdf" ? (
            <iframe src={src} title={label} className="h-[65vh] w-full" />
          ) : (
            <div className="p-6 text-center text-sm text-fg-muted">
              {broken
                ? "This file could not be loaded — it may have been moved or removed."
                : "No inline preview for this file type."}
            </div>
          )}
        </div>
        <div className="flex justify-end">
          {/* Rendered only once signed — an <a> has no disabled state,
              and an unsigned href would just 403. */}
          {src && (
            <Button asChild variant="outline" size="sm">
              <a href={src} target="_blank" rel="noopener noreferrer">
                Open in new tab
                <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
