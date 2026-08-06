import { Button } from "@loan/ui";
import { Home, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { ErrorLayout } from "./ErrorLayout";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render errors anywhere below it.
 *
 * The app had no boundary at all, which meant any component that threw
 * during render took the whole page down to a blank white screen —
 * React unmounts the entire tree when nothing catches. No message, no
 * navigation, nothing to press, and nothing in the UI to tell the
 * reader whether their work had been saved.
 *
 * A class component because that is still the only way to catch a
 * render error in React; there is no hook equivalent.
 *
 * Deliberately NOT reset on navigation. It's tempting to clear the
 * error when the route changes, but the boundary sits above the router
 * and a component that threw on some piece of state will usually throw
 * again the moment it re-renders — producing a flicker between the
 * error page and a broken screen instead of a stable place to stand.
 * "Reload" does the honest thing and starts clean.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console rather than a reporting service: there isn't one wired up
    // yet, and swallowing this silently would make the boundary worse
    // than the white screen it replaces — at least that left a stack in
    // the console. This is the line to change when Sentry lands.
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <ErrorLayout
        tone="danger"
        title="This page stopped working"
        message="Something in the app failed while drawing this screen. Reloading usually clears it, and any work already saved is safe."
        actions={
          <>
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
              Reload
            </Button>
            <Button
              variant="outline"
              // A hard assignment, not `navigate` — the router lives
              // below this boundary and is not usable from here.
              onClick={() => {
                window.location.href = "/";
              }}
            >
              <Home className="h-4 w-4" />
              Dashboard
            </Button>
          </>
        }
        details={
          /*
           * The message only, never the stack. In dev the console has
           * the full trace two feet away; in production a stack on
           * screen is a screenshot away from being pasted into a
           * support ticket, and on a lending system the frames tend to
           * carry customer identifiers.
           */
          <details className="text-xs text-fg-subtle">
            <summary className="cursor-pointer select-none">
              Technical details
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg-muted">
              {error.message || String(error)}
            </pre>
          </details>
        }
      />
    );
  }
}
