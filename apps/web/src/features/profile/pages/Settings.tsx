import {
  useClearMySignature,
  useMySignature,
  useSaveMySignature,
  useUpload,
} from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDateTime } from "@loan/shared-utils";
import { Pen, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useState } from "react";

import { SignaturePad } from "../../../components/SignaturePad";
import { useAuth } from "../../../providers/auth";
import { BrandingPanel } from "../components/BrandingPanel";
import { SessionTimeoutPanel } from "../components/SessionTimeoutPanel";
import { TwoFactorPanel } from "../components/TwoFactorPanel";

/**
 * Per-user settings page. Today: just the "My signature" panel — a
 * save-once signature that's optionally embedded in any document the user
 * downloads via the "Download with my signature" button.
 */
export function SettingsPage() {
  const { user } = useAuth();
  const sig = useMySignature();
  const save = useSaveMySignature();
  const clear = useClearMySignature();
  const upload = useUpload();
  const toast = useToast();
  const confirm = useConfirm();
  const [capturing, setCapturing] = useState(false);

  const onCapture = async (blob: Blob) => {
    try {
      const file = new File([blob], "my-signature.png", { type: "image/png" });
      const uploaded = await upload.mutateAsync({ file, subdir: "signatures" });
      await save.mutateAsync({ signatureUrl: uploaded.url });
      toast.success("Signature saved");
      setCapturing(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to save signature");
    }
  };

  const onClear = async () => {
    const ok = await confirm({
      title: "Remove your saved signature?",
      message:
        "Signed PDF downloads won't be available until you capture a new signature.",
      confirmLabel: "Remove signature",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await clear.mutateAsync();
      toast.success("Signature cleared");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <div className="space-y-4">
      <BrandingPanel />
      <SessionTimeoutPanel />
      <TwoFactorPanel />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-sky-300" />
            My settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-white/55 mb-2 flex items-center gap-1">
              <Pen className="h-3 w-3" />
              My signature
            </div>
            <p className="text-xs text-white/55 mb-3">
              Capture your signature once and reuse it. When you download a loan
              agreement, statement of account, or payment receipt, you'll get an
              extra "Download with my signature" button that embeds this
              signature as a "Prepared / Issued by" stamp. Optional — unsigned
              downloads always remain available.
            </p>

            {sig.isLoading ? (
              <SkeletonCard />
            ) : sig.data?.signatureUrl ? (
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <div className="flex items-start gap-3">
                  <img
                    src={sig.data.signatureUrl}
                    alt={`${user?.name} signature`}
                    className="h-24 w-auto max-w-xs rounded border border-white/15 bg-white p-2"
                  />
                  <div className="flex-1 text-xs text-white/65">
                    <div className="font-medium text-white">{user?.name}</div>
                    <div className="text-white/45 mt-0.5">{user?.role}</div>
                    {sig.data.savedAt && (
                      <div className="text-white/45 mt-0.5">
                        Saved {formatDateTime(sig.data.savedAt)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setCapturing(true)}
                    >
                      <Pen className="h-3 w-3" />
                      Re-capture
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onClear}
                      disabled={clear.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-white/15 bg-white/[0.02] p-4 text-center">
                <p className="text-sm text-white/55 mb-3">
                  No signature saved yet.
                </p>
                <Button onClick={() => setCapturing(true)}>
                  <Pen className="h-4 w-4" />
                  Capture signature
                </Button>
              </div>
            )}
          </div>
        </CardContent>

        {capturing && (
          <Dialog open onOpenChange={(o) => !o && setCapturing(false)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Capture your signature</DialogTitle>
              </DialogHeader>
              <SignaturePad
                onSubmit={onCapture}
                submitting={upload.isPending || save.isPending}
                label="Draw your signature using mouse, stylus, or touch."
              />
            </DialogContent>
          </Dialog>
        )}
      </Card>
    </div>
  );
}
