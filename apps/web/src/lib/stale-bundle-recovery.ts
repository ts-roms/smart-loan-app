/**
 * Escape hatch for the stale-PWA-bundle deadlock.
 *
 * The service worker uses `registerType: "prompt"` — new builds wait for
 * the user to accept the UpdatePrompt banner, so a half-typed loan
 * application never disappears under a surprise reload. That flow has
 * one fatal hole: when a deploy changes an API wire shape, the OLD
 * precached bundle doesn't go politely stale, it CRASHES during first
 * render (e.g. `(data ?? []).filter is not a function` when the list
 * endpoints started returning pagination envelopes). A crashed app
 * never mounts the update banner, the SW keeps serving the same old
 * bundle on every reload, and the user is wedged: crash → reload →
 * same bundle → crash.
 *
 * This hatch breaks the loop at the boot level, beneath React: on an
 * uncaught error or unhandled rejection in production, unregister every
 * service worker, delete every cache, and reload once. A fresh, correct
 * bundle comes down and the app recovers by itself.
 *
 * Guards, in order of importance:
 *   • once per session (sessionStorage flag) — if the SAME error recurs
 *     on the clean bundle it's a real bug, and looping reloads would
 *     bury it (and hammer the server);
 *   • production only — dev overlays and HMR handle dev;
 *   • grace period — only errors in the first 15s of life qualify.
 *     Boot crashes are the deadlock's signature; an error an hour into
 *     a session is an application bug, and nuking the user's state
 *     over it would lose real work for no recovery benefit.
 */

const SESSION_FLAG = "smartloan.staleBundleRecoveryAt";
const BOOT_WINDOW_MS = 15_000;
const bootedAt = Date.now();

async function recover(): Promise<void> {
  try {
    sessionStorage.setItem(SESSION_FLAG, String(Date.now()));
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map((k) => caches.delete(k)));
  } catch {
    // Even a partial cleanup is worth the reload attempt.
  }
  location.reload();
}

export function installStaleBundleRecovery(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  const maybeRecover = () => {
    if (sessionStorage.getItem(SESSION_FLAG)) return; // once per session
    if (Date.now() - bootedAt > BOOT_WINDOW_MS) return; // boot crashes only
    void recover();
  };

  window.addEventListener("error", maybeRecover);
  window.addEventListener("unhandledrejection", maybeRecover);
}
