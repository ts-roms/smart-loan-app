import { useToast } from "@loan/ui";
import { useEffect, useState, type ReactNode } from "react";

import { InstallPrompt } from "../components/InstallPrompt";
import { UpdatePrompt } from "../components/UpdatePrompt";

/**
 * BeforeInstallPromptEvent isn't in the standard DOM types — declare a
 * minimal shape so we can store + invoke the event without resorting to
 * `any`. Chrome / Edge / Brave fire this once when install criteria are
 * met (HTTPS or localhost, manifest valid, SW registered, not already
 * installed).
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * Wires up two PWA lifecycles into one provider:
 *
 *   1. Install affordance — listens for `beforeinstallprompt` and
 *      stashes the event so `<InstallPrompt>` can surface a button.
 *      The browser will only fire once; if the user dismisses we
 *      remember in localStorage so we don't pester them on every visit.
 *
 *   2. Service-worker updates — when vite-plugin-pwa detects a newer
 *      build, the registered SW transitions to "waiting" state. We
 *      show `<UpdatePrompt>` with a "Reload to update" CTA. The user
 *      stays in control of when to swap (a half-typed loan application
 *      shouldn't disappear because we shipped a new build).
 *
 * Keep this provider mounted near the root — App.tsx wraps everything
 * in it. Outside the dev server, vite-plugin-pwa's virtual module
 * registers the SW; the dynamic import below is the recommended hook.
 */
export function PwaProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(
    null,
  );
  const [updateFn, setUpdateFn] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    // beforeinstallprompt: cache the event, suppress the browser's
    // own install banner so we own the UX surface.
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // appinstalled: once installed, clear the event so the prompt
    // doesn't keep rendering.
    const onInstalled = () => {
      setInstallEvt(null);
      toast.success("SmartLoan installed. Look for the app icon.");
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [toast]);

  // Register the service worker and wire the update prompt. We dynamic-
  // import the virtual module so this code path is no-op in dev (where
  // the plugin returns a stub).
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const mod = await import("virtual:pwa-register");
        if (disposed) return;
        const updateSW = mod.registerSW({
          onNeedRefresh() {
            // New build is in the waiting state. Show the persistent
            // refresh banner — user decides when to swap.
            setUpdateFn(() => () => updateSW(true));
          },
          onOfflineReady() {
            // Reaches here on first successful install of the SW. Stay
            // quiet — the install affordance carries the messaging.
          },
          onRegisterError(err: unknown) {
            // Don't surface — failed SW reg shouldn't break the app.
            // eslint-disable-next-line no-console
            console.warn("[pwa] SW register failed", err);
          },
        });
      } catch (err) {
        // virtual:pwa-register doesn't resolve in dev — that's expected.
        if (import.meta.env.PROD) {
          // eslint-disable-next-line no-console
          console.warn("[pwa] SW import failed", err);
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  const handleInstall = async () => {
    if (!installEvt) return;
    await installEvt.prompt();
    const choice = await installEvt.userChoice;
    if (choice.outcome === "dismissed") {
      // User said no — remember so we don't keep nudging on every load.
      localStorage.setItem("smartloan.installDismissedAt", String(Date.now()));
    }
    setInstallEvt(null);
  };

  // Don't render the install banner when:
  //   - no installable event (already installed, not eligible, etc.)
  //   - user dismissed within the last 7 days
  const dismissedAt = Number(
    localStorage.getItem("smartloan.installDismissedAt") ?? 0,
  );
  const recentlyDismissed = Date.now() - dismissedAt < 7 * 24 * 60 * 60 * 1000;
  const showInstall = installEvt !== null && !recentlyDismissed;

  return (
    <>
      {children}
      {showInstall && (
        <InstallPrompt
          onInstall={handleInstall}
          onDismiss={() => {
            localStorage.setItem(
              "smartloan.installDismissedAt",
              String(Date.now()),
            );
            setInstallEvt(null);
          }}
        />
      )}
      {updateFn && (
        <UpdatePrompt
          onReload={async () => {
            await updateFn();
          }}
          onDismiss={() => setUpdateFn(null)}
        />
      )}
    </>
  );
}
