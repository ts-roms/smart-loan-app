import type { Metadata } from "next";
import { Suspense } from "react";

import { ConfirmPanel } from "./confirm-panel";

/**
 * Signup step 2 — where the workspace is actually built.
 *
 * URL preserved exactly: `/signup/confirm`. Under react-router this was
 * a sibling `<Route path="/signup/confirm">`; under the App Router it
 * is `app/signup/confirm/page.tsx`, which is a CHILD of app/signup. The
 * difference is invisible in the URL but real in the tree — a
 * `app/signup/layout.tsx` added later would wrap this page too, which
 * the react-router version would not have done. Nothing depends on that
 * today; it is the sort of thing that bites six months later.
 *
 * The <Suspense> is mandatory, not decorative. Without it `next build`
 * fails on the `useSearchParams()` inside ConfirmPanel — see the long
 * note in ./confirm-panel.tsx.
 */

export const metadata: Metadata = {
  title: "Confirm your workspace",
  // The token is in the query string; keep this page out of the index
  // entirely rather than relying on the crawler to ignore ?token=.
  robots: { index: false, follow: false },
};

export default function SignupConfirmPage() {
  return (
    <section className="mx-auto max-w-[620px] px-6 py-16">
      <Suspense fallback={<ConfirmFallback />}>
        <ConfirmPanel />
      </Suspense>
    </section>
  );
}

/**
 * Rendered into the static HTML and swapped out on hydration. Kept
 * deliberately quiet — this is on screen for a few milliseconds and a
 * spinner would read as "we are doing something", which we are not.
 */
function ConfirmFallback() {
  return (
    <h1 className="m-0 mb-3 text-[32px] tracking-[-0.6px]">
      Confirm your workspace
    </h1>
  );
}
