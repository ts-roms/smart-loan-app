import type { Metadata } from "next";

import { LeadForm } from "./lead-form";

/**
 * Lead capture — SERVER COMPONENT wrapping a client form.
 *
 * The heading and the intro copy are static, so they render on the
 * server; only ./lead-form.tsx crosses into the client bundle. In the
 * Vite version the whole page, headline included, was inside the
 * stateful component.
 *
 * One behaviour DID change and it is deliberate. The Vite page replaced
 * the entire page — heading and all — with the success panel. Here the
 * heading is outside the client boundary, so it stays put and only the
 * form area swaps. That reads better (the reader keeps their bearings),
 * but it is a difference, and it is the kind of difference an RSC split
 * produces by default rather than by decision. Worth watching for on a
 * screen where the heading is part of the state.
 */

export const metadata: Metadata = {
  title: "Get in touch",
  description:
    "Tell us about your cooperative and we'll send the SmartLoan install bundle and a trial licence, or set up a hosted instance.",
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-[640px] px-6 py-[60px]">
      <h1 className="m-0 mb-2 text-center text-4xl tracking-[-0.6px]">
        Get in touch
      </h1>
      <p className="m-0 mb-10 text-center text-[15px] text-fg-dim">
        Tell us about your cooperative. We&apos;ll send the install bundle and a
        trial license, or set up a hosted instance if that&apos;s a better fit.
      </p>

      <LeadForm />
    </div>
  );
}
