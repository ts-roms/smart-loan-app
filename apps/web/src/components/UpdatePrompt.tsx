import { Button } from "@loan/ui";
import { RefreshCw, X } from "lucide-react";
import { useState } from "react";

/**
 * Bottom-right banner shown when a new service-worker build is waiting.
 * The user picks the moment — auto-reload would lose in-progress form
 * state, and that's the wrong default for a financial app where
 * "submit loan application" is one button click away.
 */
export function UpdatePrompt({
  onReload,
  onDismiss,
}: {
  onReload: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      await onReload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="status"
      aria-label="SmartLoan update available"
      className="fixed bottom-4 right-4 z-[91] w-[22rem] max-w-[calc(100vw-2rem)] rounded-lg border border-emerald-400/30 bg-slate-950/90 backdrop-blur-xl shadow-2xl p-4 space-y-3"
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-md border border-emerald-400/30 bg-emerald-500/10 flex items-center justify-center">
          <RefreshCw className="h-4 w-4 text-success" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">New version available</div>
          <p className="text-xs text-fg-muted mt-0.5">
            Reload to get the latest features and fixes. Save in-progress work
            first — unsaved changes will be lost.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss update prompt"
          className="text-fg-subtle hover:text-fg -mr-1 -mt-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss} disabled={busy}>
          Later
        </Button>
        <Button size="sm" onClick={handle} disabled={busy}>
          <RefreshCw className={busy ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
          {busy ? "Reloading…" : "Reload now"}
        </Button>
      </div>
    </div>
  );
}
