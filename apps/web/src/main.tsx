import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfirmDialogProvider, Toaster } from "@loan/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ApiClientProvider } from "./providers/api";
import { AuthProvider } from "./providers/auth";
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
    <BrowserRouter>
      {/* Outermost of the app providers: everything below can read the
          theme, and nothing it renders depends on auth or data. */}
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ApiClientProvider>
              <Toaster>
                <ConfirmDialogProvider>
                  <PwaProvider>
                    <App />
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
