import { render as rtlRender } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * Shared render helper.
 *
 * Today it is a thin pass-through to @testing-library/react. It exists
 * so the providers this app will inevitably need in tests — the query
 * client, the router, the toast/confirm portals — get added in ONE
 * place rather than being copy-pasted into each spec, which is exactly
 * the duplication that motivated the shared Field in the first place.
 *
 * Components that need no provider (presentational units like Field)
 * can still be rendered through this helper; it stays correct as the
 * wrapper grows.
 */
function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Providers });
}

export * from "@testing-library/react";
