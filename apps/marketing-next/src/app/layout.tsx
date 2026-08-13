import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

import "./globals.css";

/**
 * Root layout — a Server Component, and the replacement for both
 * apps/marketing/index.html and the shell half of App.tsx.
 *
 * The <head> content that was hand-written in index.html moves into the
 * `metadata` export below. That is a real gain and the clearest single
 * argument for Next on a public site: the Vite app could only ever ship
 * ONE title and ONE description for all six routes, because there was
 * one index.html. Per-route metadata is exported by each page now, so
 * /pricing and /install finally have their own <title> and their own
 * og:description. Nothing about the Vite app could have done that
 * without a prerender step.
 */
export const metadata: Metadata = {
  // Applied to every route that does not override it; each page below
  // sets `title` and gets "<page> — SmartLoan" from the template.
  title: {
    default: "SmartLoan — Loan management software your cooperative owns",
    template: "%s — SmartLoan",
  },
  description:
    "Lending and savings software built for Philippine cooperatives. Install on your own server with a perpetual license, or use the hosted option. Your data, your hardware, your control.",
  openGraph: {
    type: "website",
    title: "SmartLoan — Loan management you own",
    description:
      "Lending software for cooperatives. On-prem first, hosted optional.",
    locale: "en_PH",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f6f7f9",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
