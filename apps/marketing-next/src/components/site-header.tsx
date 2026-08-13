"use client";

/*
 * CLIENT COMPONENT — justified.
 *
 * The header highlights the current section. In the Vite app that was
 * `useLocation()` from react-router. Under the App Router the only
 * equivalents are `usePathname()` and `useSelectedLayoutSegment()`, and
 * BOTH are client-only hooks: a Server Component in a layout has no
 * access to the request path at all (deliberately — layouts do not
 * re-render on navigation, so a server-read path would go stale the
 * moment you clicked a link).
 *
 * This is worth recording for the apps/web migration, because it is not
 * a marketing-site quirk: it is structural. Any persistent chrome that
 * reflects the current route — this nav, the console's sidebar, its
 * breadcrumb — must be a Client Component or be split so that only the
 * highlighted leaf is one. The chrome is usually the part with the most
 * imports, so "Server Components by default" tends to fail first, and
 * hardest, exactly at the shell.
 *
 * The cost here is small: this file pulls in `next/link` and nothing
 * else. It would not be small in apps/web, where the sidebar reads
 * permissions, licence features and the tenant context.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { appUrl } from "@/lib/site";

export function SiteHeader() {
  const pathname = usePathname();
  const isActive = (p: string) =>
    p === "/" ? pathname === "/" : pathname.startsWith(p);

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg-elev">
      <div className="mx-auto flex max-w-shell items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="text-[18px] font-semibold tracking-[-0.3px] text-fg no-underline hover:no-underline"
        >
          SmartLoan
        </Link>
        <nav className="flex items-center gap-7">
          <NavLink href="/pricing" active={isActive("/pricing")}>
            Pricing
          </NavLink>
          <NavLink href="/install" active={isActive("/install")}>
            Install
          </NavLink>
          <NavLink href="/contact" active={isActive("/contact")}>
            Contact
          </NavLink>
          {/*
            A plain <a>, not next/link — the app is a separate
            deployment. Members and staff both land on the same login
            screen; which console they get is decided by their role
            once they're in.
          */}
          <a
            href={`${appUrl}/login`}
            className="text-sm text-fg-dim no-underline hover:no-underline"
          >
            Sign in
          </a>
          <Link
            href="/signup"
            className="rounded-md bg-accent-strong px-4 py-2 text-sm font-medium text-white no-underline hover:no-underline"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`text-sm no-underline hover:no-underline ${
        active ? "text-fg" : "text-fg-dim"
      }`}
    >
      {children}
    </Link>
  );
}
