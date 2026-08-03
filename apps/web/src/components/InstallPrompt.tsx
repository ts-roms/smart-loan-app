import { Button } from "@loan/ui";
import { Download, X } from "lucide-react";

/**
 * Compact bottom-right banner that surfaces the browser's install
 * affordance. Rendered by `<PwaProvider>` only when the browser has
 * fired `beforeinstallprompt` AND the user hasn't dismissed within
 * the last 7 days.
 */
export function InstallPrompt({
  onInstall,
  onDismiss,
}: {
  onInstall: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Install SmartLoan"
      className="fixed bottom-4 right-4 z-[90] w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-sky-400/30 bg-slate-950/90 backdrop-blur-xl shadow-2xl p-4 space-y-3"
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-md border border-sky-400/30 bg-sky-500/10 flex items-center justify-center">
          <Download className="h-4 w-4 text-info" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Install SmartLoan</div>
          <p className="text-xs text-fg-muted mt-0.5">
            Add it to your home screen for quicker access. Opens in its own
            window — no browser chrome.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss install prompt"
          className="text-fg-subtle hover:text-fg -mr-1 -mt-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Not now
        </Button>
        <Button size="sm" onClick={onInstall}>
          <Download className="h-3 w-3" />
          Install
        </Button>
      </div>
    </div>
  );
}
