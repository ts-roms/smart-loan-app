import {
  useDisableTwoFactor,
  useEnableTwoFactor,
  useStartTwoFactorSetup,
  useTwoFactorStatus,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { Copy, Lock, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";

/**
 * Two-factor authentication panel. Three states:
 *   - not enabled → "Enable 2FA" button starts the setup flow
 *   - mid-setup   → modal shows the secret + otpauth URI; user enters the
 *                   first valid 6-digit code; on success we show recovery
 *                   codes (one-time view)
 *   - enabled     → status badge + "Disable" button (requires current code)
 *
 * The otpauth URI can be pasted into any TOTP app or rendered as a QR
 * code by the user's preferred QR library — we keep this panel
 * dependency-free.
 */
export function TwoFactorPanel() {
  const status = useTwoFactorStatus();
  const startSetup = useStartTwoFactorSetup();
  const enable = useEnableTwoFactor();
  const disable = useDisableTwoFactor();
  const toast = useToast();
  const confirm = useConfirm();

  const [setupData, setSetupData] = useState<{
    secret: string;
    otpauth: string;
  } | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const onStart = async () => {
    try {
      const data = await startSetup.mutateAsync();
      setSetupData(data);
      setEnableCode("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to start 2FA setup");
    }
  };

  const onEnable = async () => {
    try {
      const res = await enable.mutateAsync(enableCode);
      setRecoveryCodes(res.recoveryCodes);
      setSetupData(null);
      toast.success("2FA enabled");
    } catch (err) {
      toast.error((err as Error).message ?? "Code did not match");
    }
  };

  const onDisable = async () => {
    const ok = await confirm({
      title: "Disable 2FA?",
      message:
        "Your account will be protected by password alone again. Recovery codes will be invalidated.",
      confirmLabel: "Disable 2FA",
      tone: "destructive",
    });
    if (!ok) return;
    const code =
      window.prompt("Enter your current 6-digit code to confirm:") ?? "";
    if (!/^\d{6}$/.test(code)) {
      toast.error("Need a 6-digit code");
      return;
    }
    try {
      await disable.mutateAsync(code);
      toast.success("2FA disabled");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to disable");
    }
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.info("Copied");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-sky-300" />
          Two-factor authentication
        </CardTitle>
      </CardHeader>
      <CardContent>
        {status.isLoading ? (
          <SkeletonCard />
        ) : status.data?.enabled ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="success">Enabled</Badge>
              <span className="text-xs text-white/55">
                {status.data.recoveryCodesRemaining} recovery code
                {status.data.recoveryCodesRemaining === 1 ? "" : "s"} remaining
              </span>
            </div>
            <p className="text-xs text-white/55">
              Sign-in to this account requires a 6-digit code from your
              authenticator app. Lost your device? Use one of your recovery
              codes at login (each is single-use).
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onDisable}
              disabled={disable.isPending}
            >
              <ShieldOff className="h-3 w-3" />
              Disable 2FA
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-white/55">
              Add a second factor to your sign-in. After enabling, every login
              will ask for a 6-digit code from your TOTP app (Google
              Authenticator, Authy, 1Password, etc.).
            </p>
            <Button onClick={onStart} disabled={startSetup.isPending}>
              <ShieldCheck className="h-3 w-3" />
              Enable 2FA
            </Button>
          </div>
        )}
      </CardContent>

      {/* ──── Setup modal: show secret + collect first code ──── */}
      {setupData && (
        <Dialog open onOpenChange={(o) => !o && setSetupData(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Set up two-factor</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-white/65">
                Scan this URI as a QR code in your authenticator app, or paste
                the secret directly. Then enter the 6-digit code your app shows
                to confirm.
              </p>
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-2">
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-white/45">
                    otpauth URI
                  </Label>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[10px] text-white/70 truncate flex-1">
                      {setupData.otpauth}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copy(setupData.otpauth)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-white/45">
                    Secret (manual entry)
                  </Label>
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-white">
                      {setupData.secret}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => copy(setupData.secret)}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
              <div>
                <Label>Confirm with your first 6-digit code</Label>
                <Input
                  autoFocus
                  inputMode="numeric"
                  maxLength={6}
                  value={enableCode}
                  onChange={(e) =>
                    setEnableCode(e.target.value.replace(/\D/g, ""))
                  }
                  placeholder="000000"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSetupData(null)}>
                Cancel
              </Button>
              <Button
                onClick={onEnable}
                disabled={enable.isPending || enableCode.length !== 6}
              >
                {enable.isPending ? "Verifying…" : "Enable 2FA"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ──── Recovery codes (one-time view) ──── */}
      {recoveryCodes && (
        <Dialog open onOpenChange={(o) => !o && setRecoveryCodes(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Save your recovery codes</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-white/65">
              These are single-use. Keep them somewhere safe — if you lose your
              authenticator device, they're how you sign back in.
              <span className="text-rose-300 block mt-1">
                We won't show them again.
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-white/[0.03] p-3 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <div key={c} className="text-center tracking-wider">
                  {c}
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => copy(recoveryCodes.join("\n"))}
              >
                <Copy className="h-3 w-3" />
                Copy all
              </Button>
              <Button onClick={() => setRecoveryCodes(null)}>
                I've saved them
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
