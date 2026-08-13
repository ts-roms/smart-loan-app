import Link from "next/link";

import { appUrl, platformUrl } from "@/lib/site";

/**
 * SERVER COMPONENT. No directive, no hooks, no JavaScript shipped.
 *
 * Worth noting what this costs to keep on the server: the copyright
 * line calls `new Date().getFullYear()`, which is now evaluated when
 * the page is rendered rather than in the visitor's browser. For a
 * statically-generated route that means the year is frozen at BUILD
 * time. On a site that is redeployed several times a year this is fine;
 * it would be a bug on a site deployed once and left. The Vite version
 * always read the visitor's clock.
 *
 * Mentioning it because it is the smallest possible example of the real
 * hazard in an RSC migration — code does not move to the server with a
 * marker saying "this used to run per-visitor".
 */
export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border bg-bg-elev px-6 py-8">
      <div className="mx-auto flex max-w-shell flex-wrap items-start justify-between gap-8">
        <div className="max-w-[320px]">
          <div className="mb-2 text-base font-semibold text-fg">SmartLoan</div>
          <p className="m-0 text-[13px] leading-relaxed text-fg-dim">
            Loan management software built for Philippine cooperatives. On-prem
            first — your data on your hardware, with a perpetual license.
          </p>
        </div>
        <div className="flex gap-10">
          <FooterColumn
            title="Product"
            links={[
              { label: "Pricing", to: "/pricing" },
              { label: "Install", to: "/install" },
              { label: "Start a hosted trial", to: "/signup" },
            ]}
          />
          <FooterColumn
            title="Members"
            links={[
              { label: "Sign in", href: `${appUrl}/login` },
              { label: "Create an account", href: `${appUrl}/register` },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: "Contact", to: "/contact" },
              { label: "Platform console", href: platformUrl },
            ]}
          />
        </div>
      </div>
      <div className="mx-auto mt-8 max-w-shell border-t border-border pt-5 text-xs text-fg-muted">
        © {new Date().getFullYear()} SmartLoan. Built for Philippine
        cooperatives.
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ label: string; to?: string; href?: string }>;
}) {
  return (
    <div>
      <div className="mb-3 text-xs uppercase tracking-[0.5px] text-fg-muted">
        {title}
      </div>
      <ul className="m-0 list-none p-0">
        {links.map((l) => (
          <li key={l.label} className="mb-2">
            {l.to ? (
              <Link
                href={l.to}
                className="text-[13px] text-fg-dim no-underline hover:no-underline"
              >
                {l.label}
              </Link>
            ) : (
              <a
                href={l.href}
                className="text-[13px] text-fg-dim no-underline hover:no-underline"
              >
                {l.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
