import { Button } from "@loan/ui";
import { Eraser } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Canvas-based signature pad. Captures mouse/touch strokes, exposes the
 * final image as a PNG blob via the `onSubmit` callback.
 *
 * No external dependency — we draw straight lines between successive
 * `pointermove` events. That's enough fidelity for a legal signature
 * image; a smoother bézier path is an upgrade for v2 if needed.
 */
export function SignaturePad({
  onSubmit,
  submitting,
  height = 180,
  label = "Sign here",
}: {
  onSubmit: (blob: Blob) => void | Promise<void>;
  submitting?: boolean;
  height?: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  // Size the canvas to its container (responsive). Re-runs on resize.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const fit = () => {
      const w = cv.parentElement?.clientWidth ?? 400;
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr;
      cv.height = height * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${height}px`;
      const ctx = cv.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#0f172a";
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [height]);

  const getXY = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current!.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    lastRef.current = getXY(e);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const next = getXY(e);
    const last = lastRef.current!;
    const ctx = canvasRef.current!.getContext("2d");
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }
    lastRef.current = next;
    if (empty) setEmpty(false);
  };

  const onUp = () => {
    drawingRef.current = false;
    lastRef.current = null;
  };

  const clear = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    setEmpty(true);
  };

  const submit = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.toBlob((blob) => {
      if (blob) void onSubmit(blob);
    }, "image/png");
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-fg-muted">{label}</div>
      <canvas
        ref={canvasRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="block rounded-md border border-default touch-none bg-white"
        style={{ height }}
      />
      <div className="flex justify-between items-center">
        <Button type="button" variant="outline" size="sm" onClick={clear}>
          <Eraser className="h-3 w-3" />
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          loading={submitting}
          disabled={empty}
        >
          Save signature
        </Button>
      </div>
    </div>
  );
}
