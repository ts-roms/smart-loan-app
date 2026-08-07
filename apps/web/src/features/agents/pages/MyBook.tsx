import { useMyAgentBook } from "@loan/api-client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { Briefcase } from "lucide-react";

import { AgentBookTable } from "../components/AgentBookTable";
import { AgentStats } from "../components/AgentStats";

/**
 * What an agent sees of themselves: their loans, and what they made.
 *
 * There is no id in the URL and no agent picker. The server resolves the
 * agent from the token, so this page renders one book and only one — an
 * agent cannot reach a colleague's earnings by editing an address bar.
 *
 * Borrower names appear but are not linked: the AGENT role does not
 * carry `customers.read`, so those links would 403. Their own book is
 * the only borrower data they are given, and that is by design.
 */
export function MyBookPage() {
  const book = useMyAgentBook();

  if (book.isLoading) return <SkeletonCard />;

  if (book.isError) {
    /*
     * Almost always one thing: a signed-in user with the permission but
     * no Agent row behind them. The API says so in the message, so pass
     * it through rather than replacing it with "something went wrong" —
     * "ask an administrator to register you as an agent" is actionable
     * and the generic version is not.
     */
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-fg-muted">
            {(book.error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }

  const data = book.data!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">My book</h1>
        <p className="text-xs text-fg-muted">
          {data.agent.number}
          {data.agent.territory ? ` · ${data.agent.territory}` : ""}
        </p>
      </div>

      <AgentStats totals={data.totals} voice="own" />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Briefcase className="h-4 w-4" />
            Loans you brought in
          </CardTitle>
        </CardHeader>
        <CardContent>
          <AgentBookTable loans={data.loans} />
          <p className="mt-3 text-[11px] text-fg-subtle">
            Commission is earned when the loan is disbursed, not when it is
            approved. Rows still in review show what they would pay.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
