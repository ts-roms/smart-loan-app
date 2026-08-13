import type { Metadata } from "next";

import { SignupForm } from "./signup-form";

/**
 * Hosted signup — provisions a cooperative's workspace with no vendor
 * in the loop.
 *
 * The site's whole pitch is on-prem ownership, so this page doesn't
 * pretend hosted is the better choice; it says plainly what you give
 * up and points at /install for the alternative.
 *
 * Two states: the form, and "check your email". Nothing is created
 * here — the workspace is built on /signup/confirm, once the link in
 * that email is clicked. A mistyped address therefore costs an
 * expiring row rather than a live tenant nobody can reach.
 *
 * This page is a SERVER COMPONENT that renders almost nothing: both
 * states are inside the client form, because the second one replaces
 * the heading too. Splitting the copy out would have changed what the
 * reader sees. Noted as the counter-example to /contact, where the
 * same split was worth making.
 */

export const metadata: Metadata = {
  title: "Start a hosted trial",
  description:
    "Set up a private SmartLoan workspace for your cooperative. Free for 30 days, no card, ready in about a minute.",
};

export default function SignupPage() {
  return (
    <section className="mx-auto max-w-[620px] px-6 py-16">
      <SignupForm />
    </section>
  );
}
