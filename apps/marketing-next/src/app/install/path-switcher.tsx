"use client";

import type { ReactNode } from "react";
import { useState } from "react";

/*
 * CLIENT COMPONENT — justified, and deliberately hollow.
 *
 * The only thing on /install that needs the browser is which of two
 * tabs is selected. In the Vite version that `useState<Path>` sat at
 * the top of the page component, so the ENTIRE install guide — every
 * prerequisite table, every shell snippet, both six-step walkthroughs
 * — was inside a stateful component and shipped as JavaScript.
 *
 * Here the two guides are Server Components rendered by the page and
 * handed in as `docker` / `bareMetal` props. React serialises them into
 * the RSC payload; this component only chooses which prop to place. The
 * result is that the tab switch is instant and client-side, and none of
 * the ~400 lines of guide content is in the client bundle.
 *
 * This "server content, client shell" split is the single most
 * transferable technique the pilot found, and it applies far beyond a
 * tab strip: any wrapper whose interactivity is layout-level rather
 * than content-level (accordion, modal, drawer, sidebar, tab set) can
 * take its content as `children` and stay a thin client leaf. For
 * apps/web it is the difference between "the dashboard is a Client
 * Component" and "the dashboard's collapsible panels are".
 *
 * The catch, and it is a real one: props crossing the boundary must be
 * serialisable. `ReactNode` is; a function is not. A tab strip that
 * needed an `onSelect` callback supplied by the server parent could not
 * be written this way at all.
 */

export type InstallPath = "docker" | "bare-metal";

export function PathSwitcher({
  docker,
  bareMetal,
}: {
  docker: ReactNode;
  bareMetal: ReactNode;
}) {
  const [path, setPath] = useState<InstallPath>("docker");

  return (
    <>
      <section className="mx-auto max-w-[820px] px-6 pt-10">
        <div className="grid grid-cols-2 gap-3">
          <PathCard
            active={path === "docker"}
            onClick={() => setPath("docker")}
            title="Docker"
            subtitle="docker compose up -d"
            body="Single compose file. PostgreSQL, API, and web ship as images. Easiest path if your team already runs containers."
            timeToRunning="~15 min"
          />
          <PathCard
            active={path === "bare-metal"}
            onClick={() => setPath("bare-metal")}
            title="Bare-metal"
            subtitle="systemd + nginx"
            body="Single install.sh sets up Node, Postgres, the service, and an nginx config. Native daemon, no container runtime."
            timeToRunning="~30 min"
          />
        </div>
      </section>
      <section className="mx-auto max-w-[820px] px-6 pb-[60px] pt-8">
        {path === "docker" ? docker : bareMetal}
      </section>
    </>
  );
}

function PathCard({
  active,
  onClick,
  title,
  subtitle,
  body,
  timeToRunning,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  body: string;
  timeToRunning: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-[10px] border p-5 text-left font-[inherit] text-fg ${
        active ? "border-accent bg-accent-soft" : "border-border bg-bg-elev"
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="m-0 text-lg">{title}</h3>
        <span className="text-[11px] uppercase tracking-[0.5px] text-fg-muted">
          {timeToRunning}
        </span>
      </div>
      <code className="bg-transparent p-0 text-xs text-accent">{subtitle}</code>
      <p className="mb-0 mt-2.5 text-[13px] leading-[1.5] text-fg-dim">
        {body}
      </p>
    </button>
  );
}
