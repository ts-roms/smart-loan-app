import { ConfirmDialogProvider, Toaster } from "@loan/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  render as rtlRender,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi } from "vitest";

import { BreadcrumbTitleProvider } from "../providers/breadcrumb-titles";

/**
 * Render a page or component with the providers it actually needs.
 *
 * The stack mirrors main.tsx minus the three that a component test has
 * no business exercising:
 *
 *   ThemeProvider      — reads matchMedia and writes a class on <html>;
 *                        nothing under test branches on it.
 *   AuthProvider /     — these own the token and the fetch wrapper.
 *   ApiClientProvider    Tests mock @loan/api-client at the module
 *                        boundary instead, so a test never depends on
 *                        how a request is built, only on what a hook
 *                        returns. That is the seam that stays stable
 *                        when the transport changes.
 *   PwaProvider        — registers a service worker.
 *
 * Retries are off. A hook mocked to return an error should surface it
 * on the first render, not three seconds later.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderOptions & {
    /** Initial URL. Use with `path` for pages that read useParams. */
    route?: string;
    /** Route pattern, e.g. "/customers/:id". */
    path?: string;
  } = {},
) {
  const { route = "/", path, ...rest } = options;

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <Toaster>
          <ConfirmDialogProvider>
            <BreadcrumbTitleProvider>
              <MemoryRouter initialEntries={[route]}>
                {path ? (
                  <Routes>
                    <Route path={path} element={children} />
                  </Routes>
                ) : (
                  children
                )}
              </MemoryRouter>
            </BreadcrumbTitleProvider>
          </ConfirmDialogProvider>
        </Toaster>
      </QueryClientProvider>
    );
  }

  return rtlRender(ui, { wrapper: Wrapper, ...rest });
}

/**
 * A settled TanStack query, shaped like the fields components read.
 *
 * Deliberately not the full UseQueryResult — a test that had to supply
 * forty fields to say "the data arrived" would be unreadable, and the
 * extra fields are ones no component under test touches.
 */
export function loaded<T>(data: T) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
  };
}

/**
 * A hook stub, settled and empty until a test says otherwise.
 *
 * The return type is deliberately `unknown`. Inferring it from the
 * default would pin the mock to `{ data: undefined }` and make every
 * `mockReturnValue(loaded(x))` a type error — the stub's job is to
 * stand in for a hook, not to promise what that hook returns.
 */
export function queryHook() {
  return vi.fn<(...args: never[]) => unknown>(() => loaded(undefined));
}

/** The same, for a mutation hook. */
export function mutationHook() {
  return vi.fn<(...args: never[]) => unknown>(() => mutation());
}

export function loading() {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: () => {},
  };
}

/** A mutation stub that records what it was called with. */
export function mutation(impl?: (input: unknown) => unknown) {
  const calls: unknown[] = [];
  return {
    calls,
    mutate: (input: unknown) => {
      calls.push(input);
      return impl?.(input);
    },
    mutateAsync: (input: unknown) => {
      calls.push(input);
      return Promise.resolve(impl?.(input));
    },
    isPending: false,
    isError: false,
    error: null,
    reset: () => {},
  };
}

/**
 * The no-provider render, kept from main.
 *
 * Presentational units — Field and friends — need none of the stack
 * above, and a test that mounts a router and a query client to assert
 * on a label is a test that fails for reasons it does not care about.
 * Both helpers exist because both kinds of test exist.
 */
function Providers({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: Providers });
}

export * from "@testing-library/react";
