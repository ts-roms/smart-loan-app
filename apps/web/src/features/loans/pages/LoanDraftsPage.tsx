import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import { ArrowRight, CreditCard, FileEdit, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useDeleteLoanDraft, useLoanDrafts, useLoanProducts } from "../hooks";

/**
 * Officer's saved loan-application drafts. One row per draft owned by
 * the current user; ADMINs see only their own (no cross-user listing
 * surface today — keep drafts private per author).
 *
 * Actions per row:
 *   - "Resume" → /loans/new/:draftId (loads the wizard with the snapshot)
 *   - "Discard" → DELETE the draft, with confirmation
 */
export function LoanDraftsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const drafts = useLoanDrafts();
  const products = useLoanProducts();
  const del = useDeleteLoanDraft();

  const productName = (code: string | null): string =>
    code ? (products.data?.find((p) => p.code === code)?.name ?? code) : "—";

  const onDiscard = async (id: string) => {
    const ok = await confirm({
      title: "Discard this draft?",
      message:
        "The wizard state will be permanently deleted. This cannot be undone.",
      confirmLabel: "Discard",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await del.mutateAsync(id);
      toast.success("Draft discarded");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not discard");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
        <CardTitle className="flex items-center gap-2">
          <FileEdit className="h-4 w-4 text-info" />
          My loan drafts
        </CardTitle>
        <Button size="sm" onClick={() => navigate("/loans/new")}>
          <Plus className="h-3 w-3" />
          Start new application
        </Button>
      </CardHeader>
      <CardContent>
        {drafts.isLoading ? (
          <SkeletonCard />
        ) : (drafts.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">
            No drafts saved. Start a{" "}
            <button
              type="button"
              onClick={() => navigate("/loans/new")}
              className="text-info hover:underline"
            >
              new application
            </button>{" "}
            and hit <strong>Save draft</strong> to come back to it later.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Started</th>
                <th className="py-2 px-2">Customer</th>
                <th className="py-2 px-2">Product</th>
                <th className="py-2 px-2">Principal</th>
                <th className="py-2 px-2">Last edited</th>
                <th className="py-2 px-2">Progress</th>
                <th className="py-2 px-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(drafts.data ?? []).map((d) => {
                // formState is opaque server-side; we know the wizard
                // stores `principal` + customer name fields, so dig in
                // defensively here without bringing the type along.
                const fs = (d.formState ?? {}) as Record<string, unknown>;
                const principal =
                  typeof fs.principal === "number" ? fs.principal : 0;
                const customerLabel = d.customerId
                  ? d.customerId.slice(0, 8) + "…"
                  : "Not picked";
                return (
                  <tr key={d.id} className="hover:bg-hover">
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDate(d.createdAt)}
                    </td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {customerLabel}
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant="muted">
                        {productName(d.productCode)}
                      </Badge>
                    </td>
                    <td className="py-2 px-2 font-mono">
                      {principal > 0 ? formatMoney(principal) : "—"}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDateTime(d.updatedAt)}
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant="muted">Step {d.lastStep + 1}/5</Badge>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="inline-flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/loans/new/${d.id}`)}
                        >
                          <CreditCard className="h-3 w-3" />
                          Resume
                          <ArrowRight className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDiscard(d.id)}
                          className="text-danger hover:text-danger"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
