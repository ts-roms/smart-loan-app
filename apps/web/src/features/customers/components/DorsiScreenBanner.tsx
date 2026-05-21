import {
  useDorsiForCustomer,
  useScreenDorsiByName,
  type DorsiNameMatch,
} from "@loan/api-client";
import { Badge, Button, cn } from "@loan/ui";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

/**
 * DORSI auto-screen banner — FRD §3.10.1.
 *
 * Shown on the customer detail page. Runs a fuzzy name screen against
 * the active DORSI register and surfaces a banner when potential
 * matches are found, prompting the officer to manually confirm whether
 * this customer is DORSI-related.
 *
 * Suppressed when the customer is already tagged (the existing DORSI
 * record is informative enough).
 */
export function DorsiScreenBanner({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const existing = useDorsiForCustomer(customerId);
  const screen = useScreenDorsiByName();
  const [matches, setMatches] = useState<DorsiNameMatch[]>([]);
  const [ran, setRan] = useState(false);

  // Run the screen once when the page mounts (after we know whether the
  // customer is already DORSI-tagged — no point screening if they are).
  useEffect(() => {
    if (existing.isLoading) return;
    if (existing.data) return;
    if (ran) return;
    setRan(true);
    screen
      .mutateAsync(customerName)
      .then((m) => setMatches(m.filter((x) => x.customerId !== customerId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data, existing.isLoading, ran, customerName, customerId]);

  // Customer already tagged — show a different banner so the officer
  // sees the DORSI category at a glance.
  if (existing.data) {
    return (
      <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100 flex items-center gap-2">
        <ShieldCheck className="h-3 w-3" />
        <span>
          This customer is tagged as{" "}
          <strong>DORSI · {existing.data.category}</strong>. Basis:{" "}
          {existing.data.basis}
        </span>
        <Link
          to="/compliance/dorsi"
          className="ml-auto text-sky-300 hover:underline"
        >
          View register →
        </Link>
      </div>
    );
  }

  const topMatch = matches[0];
  if (!topMatch) return null;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        topMatch.similarity >= 0.85
          ? "border-rose-400/40 bg-rose-400/10 text-rose-100"
          : "border-amber-400/40 bg-amber-400/10 text-amber-100",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="h-3 w-3" />
        <strong>
          Potential DORSI match — FRD §3.10.1 requires confirmation.
        </strong>
      </div>
      <ul className="space-y-1 mt-1">
        {matches.slice(0, 5).map((m) => (
          <li
            key={m.recordId}
            className="flex items-center justify-between gap-2"
          >
            <span>
              <Link
                to={`/customers/${m.customerId}`}
                className="text-sky-300 hover:underline"
              >
                {m.customerName}
              </Link>{" "}
              · {m.category} · <span className="text-white/65">{m.reason}</span>
            </span>
            <Badge variant={m.similarity >= 0.85 ? "danger" : "warning"}>
              {(m.similarity * 100).toFixed(0)}%
            </Badge>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to="/compliance/dorsi">Open DORSI register</Link>
        </Button>
      </div>
    </div>
  );
}
