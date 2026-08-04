import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmDialogProvider, Toaster } from "@loan/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ApiClientProvider } from "./providers/api";
import { AuthProvider } from "./providers/auth";
import { BreadcrumbTitleProvider } from "./providers/breadcrumb-titles";
import { PwaProvider } from "./providers/pwa";
import { ThemeProvider } from "./providers/theme";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/*
      basename comes from Vite's BASE_URL, which is the `base` set in
      vite.config.ts — so the router and the built asset paths can't
      disagree. Deployed that is "/app/", locally "/".

      Trailing slash stripped: BASE_URL always ends in one, and
      react-router expects a basename without it ("/app"). "/" becomes
      "" , which react-router treats as no basename at all — correct
      for local dev.
    */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      {/* Outermost of the app providers: everything below can read the
          theme, and nothing it renders depends on auth or data. */}
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ApiClientProvider>
              <Toaster>
                <ConfirmDialogProvider>
                  <PwaProvider>
                    {/* Holds record names for the breadcrumb trail.
                        Above <App /> so a title published by a detail
                        page survives navigating deeper into it. */}
                    <BreadcrumbTitleProvider>
                      <App />
                    </BreadcrumbTitleProvider>
                  </PwaProvider>
                </ConfirmDialogProvider>
              </Toaster>
            </ApiClientProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
