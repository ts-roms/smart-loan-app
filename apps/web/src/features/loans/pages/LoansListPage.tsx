import type { LoanListQuery, LoanStatus } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { CreditCard, FileEdit, Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { usePermission } from "../../../hooks/use-permission";
import { useDebouncedValue } from "../../../lib/use-debounced-value";
import { LoanStatusBadge } from "../components/StatusBadge";
import { QuickLoanLink } from "../components/QuickLoanDrawer";
import { LOAN_STATUS_OPTIONS, TYPE_LABELS } from "../constants";
import { useLoanDrafts, useLoanProducts, useLoansPage } from "../hooks";
import { findArticle, TourButton } from "../../help";

/**
 * Loan list page. Renders the master table and hosts the "new loan"
 * dialog. The dialog itself is product-aware and self-contained — see
 * `components/NewLoanDialog.tsx`.
 *
 * Search and filtering are server-side. The list is capped at 200 rows,
 * so filtering what was already fetched would search the newest page and
 * quietly miss the older loan the officer went looking for — which reads
 * as "that loan doesn't exist".
 */
/** Rows per page in the table. The endpoint's own default is 200. */
const PAGE_SIZE = 25;

export function LoansListPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LoanStatus | "ALL">("ALL");
  const [productCode, setProductCode] = useState("ALL");
  const [page, setPage] = useState(1);

  // Only the debounced copy reaches the query key, so a typed word is one
  // request rather than one per keystroke.
  const q = useDebouncedValue(search.trim()) || undefined;
  const filter: LoanListQuery = {
    q,
    status: status === "ALL" ? undefined : status,
    productCode: productCode === "ALL" ? undefined : productCode,
    page,
    pageSize: PAGE_SIZE,
  };
  const filtered = Boolean(filter.q || filter.status || filter.productCode);

  // Narrowing the filter reshuffles the result set, so the page number
  // the operator was on no longer means anything — page 4 of a two-page
  // result is an empty table that reads as "no matches". Reset on every
  // filter change, including the debounced query.
  useEffect(() => {
    setPage(1);
  }, [q, status, productCode]);

  const loans = useLoansPage(filter);
  /*
   * `loans.read` gets you this list; originating one needs
   * `loans.apply`, which ACCOUNTANT and COLLECTOR do not hold. The
   * button was rendered unconditionally, so both roles could walk into
   * a six-step wizard and only find out at submit.
   *
   * Drafts are deliberately NOT gated on it — the draft endpoints
   * require `loans.read`, so anyone who can see this page can see their
   * own saved work.
   */
  const canApply = usePermission("loans.apply");
  const products = useLoanProducts();
  const drafts = useLoanDrafts();
  const navigate = useNavigate();

  const tourSteps = findArticle("loans-list")?.tour ?? [];
  const draftCount = drafts.data?.length ?? 0;
  const rows = loans.data?.rows ?? [];
  const total = loans.data?.total ?? 0;

  const clearFilters = () => {
    setSearch("");
    setStatus("ALL");
    setProductCode("ALL");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          Loans
        </CardTitle>
        <div className="flex items-center gap-2">
          <TourButton tourId="loans-list" steps={tourSteps} />
          {draftCount > 0 && (
            <Button
              variant="outline"
              onClick={() => navigate("/loans/drafts")}
              title={`${draftCount} saved draft${draftCount === 1 ? "" : "s"}`}
            >
              <FileEdit className="h-4 w-4" />
              Drafts ({draftCount})
            </Button>
          )}
          {canApply && (
            <Button
              onClick={() => navigate("/loans/new")}
              data-tour="loans-new"
            >
              <Plus className="h-4 w-4" />
              New application
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle" />
            <Input
              className="pl-8"
              placeholder="Search number or borrower…"
              aria-label="Search loans"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as LoanStatus | "ALL")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {LOAN_STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={productCode} onValueChange={setProductCode}>
            <SelectTrigger className="w-44" aria-label="Filter by product">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All products</SelectItem>
              {(products.data ?? []).map((p) => (
                <SelectItem key={p.code} value={p.code}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtered && (
            <Button variant="ghost" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          {/* Match count, not row count — the table shows one page. The
              range readout lives with the page control at the bottom. */}
          <span className="text-xs text-fg-muted ml-auto">
            {total} loan{total === 1 ? "" : "s"}
          </span>
        </div>

        {loans.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
          </div>
        ) : rows.length === 0 ? (
          // Two different situations, two different messages: an empty
          // book needs a nudge to create something, an empty result set
          // needs a nudge to loosen the filter.
          <p className="text-sm text-fg-muted">
            {filtered ? "No loans match those filters." : "No loans yet."}
          </p>
        ) : (
          <table className="w-full text-sm" data-tour="loans-table">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Number</th>
                <th className="py-2 px-2">Borrower</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Principal</th>
                {/* Outstanding, not disbursed — the number an officer
                    triaging a queue is actually reading for. */}
                <th className="py-2 px-2">Balance</th>
                <th className="py-2 px-2">Term</th>
                <th className="py-2 px-2">Rate</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Submitted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {rows.map((l) => (
                <tr key={l.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">
                    <QuickLoanLink id={l.id}>{l.number}</QuickLoanLink>
                  </td>
                  {/* Optional on the type because only the list endpoint
                      joins it — an em dash beats a crash if it's absent.
                      The name links to the borrower's profile: an officer
                      scanning the book is one click from the person. */}
                  <td className="py-2 px-2">
                    {l.customer ? (
                      <Link
                        to={`/customers/${l.customer.number}`}
                        className="text-info hover:underline"
                      >
                        {l.customer.firstName} {l.customer.lastName}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1">
                      <Badge variant="muted">
                        {TYPE_LABELS[l.productCode] ?? l.productCode}
                      </Badge>
                      {l.isRepeat && (
                        <Badge variant="success" title="Repeat borrower">
                          Repeat
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    {formatMoney(Number(l.principal))}
                  </td>
                  {/* An em dash, not ₱0.00, before disbursement — no
                      schedule yet is not the same as nothing owed. */}
                  <td className="py-2 px-2">
                    {l.balance ? formatMoney(l.balance.outstanding) : "—"}
                  </td>
                  <td className="py-2 px-2">{l.termMonths}m</td>
                  <td className="py-2 px-2">
                    {(Number(l.annualInterestRate) * 100).toFixed(2)}%
                  </td>
                  <td className="py-2 px-2">
                    <LoanStatusBadge status={l.status} />
                  </td>
                  <td className="py-2 px-2 text-xs text-fg-muted">
                    {formatDate(l.submittedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Rendered whenever there's anything to page through. Hidden on
            an empty result — "No loans" is already said above it. */}
        {rows.length > 0 && (
          <Pagination
            page={loans.data?.page ?? 1}
            totalPages={loans.data?.totalPages ?? 1}
            total={total}
            pageSize={loans.data?.pageSize ?? PAGE_SIZE}
            onPageChange={setPage}
            noun="loan"
            busy={loans.isFetching}
          />
        )}
      </CardContent>
    </Card>
  );
}
