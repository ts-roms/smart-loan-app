import type { AgentBookTotals } from "@loan/shared-types";
import { formatMoney } from "@loan/shared-utils";
import { Banknote, FileStack, HandCoins, Hourglass } from "lucide-react";

/**
 * The four numbers that describe an agent's book.
 *
 * Earned and pipeline are shown side by side and never summed. They are
 * different kinds of claim: one is money the coop has already booked as
 * owed to the agent, the other is what they stand to make if every
 * application in flight funds — which some of them will not. Adding them
 * would produce a figure an agent could plan around and shouldn't.
 */
export function AgentStats({
  totals,
  voice = "third",
}: {
  totals: AgentBookTotals;
  /** "own" phrases the labels for the agent reading their own page. */
  voice?: "third" | "own";
}) {
  const own = voice === "own";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        icon={HandCoins}
        label={own ? "You've earned" : "Earned"}
        value={formatMoney(totals.earned)}
        sub="On loans that were released"
        accent="success"
      />
      <Stat
        icon={Hourglass}
        label="In the pipeline"
        value={formatMoney(totals.pipeline)}
        sub="If everything in flight funds"
        accent="warning"
      />
      <Stat
        icon={Banknote}
        label="Funded loans"
        value={String(totals.fundedCount)}
        sub="Reached disbursement"
      />
      <Stat
        icon={FileStack}
        label={own ? "You brought in" : "Applications"}
        value={String(totals.loanCount)}
        sub="Every status"
      />
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Banknote;
  label: string;
  value: string;
  sub: string;
  accent?: "success" | "warning";
}) {
  const color =
    accent === "success"
      ? "text-success"
      : accent === "warning"
        ? "text-warning"
        : "text-fg";
  return (
    <div className="rounded-lg border border-default bg-surface-1 p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-subtle">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={`mt-1 text-lg font-semibold tabular ${color}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-fg-muted">{sub}</div>
    </div>
  );
}
