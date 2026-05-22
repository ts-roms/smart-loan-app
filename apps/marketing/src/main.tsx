import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";

/**
 * Marketing app entry. No QueryClient — there's barely any async
 * state on this site (just the contact form POST). Keeping the
 * dep footprint small for first-paint.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
