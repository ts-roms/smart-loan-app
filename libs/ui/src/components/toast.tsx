import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
}

interface ToastApi {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <Toaster>");
  return ctx;
}

export function Toaster({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, title: string) => {
    setItems((curr) => [
      ...curr,
      { id: Date.now() + Math.random(), kind, title },
    ]);
  }, []);

  const api: ToastApi = {
    success: (m) => push("success", m),
    error: (m) => push("error", m),
    info: (m) => push("info", m),
  };

  return (
    <ToastCtx.Provider value={api}>
      <ToastPrimitive.Provider duration={5000} swipeDirection="right">
        {children}
        {items.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            onOpenChange={(open) => {
              if (!open) setItems((curr) => curr.filter((x) => x.id !== t.id));
            }}
            className={cn(
              "group pointer-events-auto relative flex w-[20rem] items-start gap-3 rounded-md border p-3 shadow-lg backdrop-blur-md",
              t.kind === "success" && "border-emerald-400/30 bg-emerald-500/10",
              t.kind === "error" && "border-rose-400/30 bg-rose-500/10",
              t.kind === "info" && "border-sky-400/30 bg-sky-500/10",
              // Slide in from the right, slide back out on auto-dismiss /
              // close. The swipe-cancel transition lets a flicked-then-
              // released toast rubber-band back into place smoothly.
              "data-[state=open]:animate-toast-in",
              "data-[state=closed]:animate-toast-out",
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
              "data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform data-[swipe=cancel]:duration-150",
              "data-[swipe=end]:animate-toast-swipe-out",
            )}
          >
            <ToastPrimitive.Title className="text-sm font-medium flex-1">
              {t.title}
            </ToastPrimitive.Title>
            <ToastPrimitive.Close className="opacity-60 hover:opacity-100">
              <X className="h-4 w-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] m-4 flex w-[20rem] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastCtx.Provider>
  );
}
