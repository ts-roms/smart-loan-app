import {
  useBigBrother,
  useContributions,
  useCreateBigBrother,
  useCreateContribution,
  useCreateExpense,
  useCreateFundTxn,
  useCreateFundWithdrawal,
  useCreateOtherIncome,
  useCreateSavings,
  useCustomers,
  useExpenses,
  useFundTxns,
  useFundWithdrawals,
  useOtherIncome,
  useSavingsTxns,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DatePicker,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  cn,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney, todayLocalISO } from "@loan/shared-utils";
import {
  Banknote,
  Building2,
  HandCoins,
  PiggyBank,
  Plus,
  Receipt,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { CustomerPicker } from "../components/CustomerPicker";
import { MemberLedgerLink } from "../components/MemberLedgerDrawer";
import { JournalEntryLink } from "../../accounting";
import { findArticle, TourButton } from "../../help";

import { usePermission } from "../../../hooks/use-permission";

/**
 * Single-page cooperative module. Horizontal tabs for each entity;
 * each tab renders a list + "New" button that opens a record-specific
 * dialog. All writes auto-post to the GL on the API side.
 *
 * Source-of-funds buckets are free-form on the wire but the dialogs
 * pre-populate a canonical list so the user doesn't fight string parity
 * with the GL mapper.
 */

const FUND_BUCKETS = [
  "CAPITAL_BUILD_UP",
  "MORTUARY_FUND",
  "EMERGENCY_FUND",
  "SAVINGS",
  "BIG_BROTHER",
  "GENERAL",
  "OTHER",
] as const;

type Tab =
  | "contributions"
  | "savings"
  | "funds"
  | "withdrawals"
  | "expenses"
  | "income"
  | "big-brother";

const TABS: Array<{ key: Tab; label: string; icon: typeof PiggyBank }> = [
  { key: "contributions", label: "Contributions", icon: HandCoins },
  { key: "savings", label: "Savings", icon: PiggyBank },
  { key: "funds", label: "Funds", icon: TrendingUp },
  { key: "withdrawals", label: "Withdrawals", icon: TrendingDown },
  { key: "expenses", label: "Expenses", icon: Receipt },
  { key: "income", label: "Other income", icon: Sparkles },
  { key: "big-brother", label: "Big Brother", icon: Building2 },
];

export function CooperativePage() {
  const [tab, setTab] = useState<Tab>("contributions");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-info" />
            Cooperative modules
          </CardTitle>
          <TourButton
            tourId="cooperative"
            steps={findArticle("cooperative")?.tour ?? []}
          />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-muted mb-3">
            Member dues, savings, fund movements, expenses, and external capital
            — every entry auto-posts to the general ledger.
          </p>
          <div
            className="flex flex-wrap gap-1 border-b border-default pb-2"
            data-tour="coop-tabs"
          >
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
                  tab === t.key
                    ? "bg-info/15 text-fg border border-info/30"
                    : "text-fg-muted hover:bg-hover hover:text-fg border border-transparent",
                )}
              >
                <t.icon className="h-3 w-3" />
                {t.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {tab === "contributions" && <ContributionsTab />}
      {tab === "savings" && <SavingsTab />}
      {tab === "funds" && <FundsTab />}
      {tab === "withdrawals" && <WithdrawalsTab />}
      {tab === "expenses" && <ExpensesTab />}
      {tab === "income" && <OtherIncomeTab />}
      {tab === "big-brother" && <BigBrotherTab />}
    </div>
  );
}

/** Customer lookup helper — used by every tab that shows a member column. */
function useCustomerName() {
  const { data } = useCustomers();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const c of data ?? []) {
      map.set(c.id, `${c.firstName} ${c.lastName}`);
    }
    return (id: string | null | undefined) => (id ? (map.get(id) ?? "—") : "—");
  }, [data]);
}

// ─── Contributions ───────────────────────────────────────────────

function ContributionsTab() {
  const list = useContributions();
  const canCreate = usePermission("coop.contribute");
  const create = useCreateContribution();
  const nameOf = useCustomerName();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [cbu, setCbu] = useState(0);
  const [mortuary, setMortuary] = useState(0);
  const [emergency, setEmergency] = useState(0);
  const [notes, setNotes] = useState("");

  const reset = () => {
    setCustomerId("");
    setCbu(0);
    setMortuary(0);
    setEmergency(0);
    setNotes("");
    setOpen(false);
  };

  const total = cbu + mortuary + emergency;

  const onSubmit = async () => {
    if (!customerId) {
      toast.error("Pick a member");
      return;
    }
    if (total <= 0) {
      toast.error("At least one bucket must be > 0");
      return;
    }
    try {
      await create.mutateAsync({
        customerId,
        capitalBuildUp: cbu,
        mortuaryFund: mortuary,
        emergencyFund: emergency,
        notes: notes || undefined,
      });
      toast.success("Contribution recorded");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Contributions"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Member</th>
            <th className="py-2 px-2 text-right">CBU</th>
            <th className="py-2 px-2 text-right">Mortuary</th>
            <th className="py-2 px-2 text-right">Emergency</th>
            <th className="py-2 px-2 text-right">Total</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((c) => {
            const t =
              Number(c.capitalBuildUp) +
              Number(c.mortuaryFund) +
              Number(c.emergencyFund);
            return (
              <tr key={c.id} className="hover:bg-hover">
                <td className="py-2 px-2 text-xs">
                  {formatDate(c.contributedAt)}
                </td>
                <td className="py-2 px-2">
                  <MemberLedgerLink customerId={c.customerId}>
                    {nameOf(c.customerId)}
                  </MemberLedgerLink>
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs">
                  {formatMoney(Number(c.capitalBuildUp))}
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs">
                  {formatMoney(Number(c.mortuaryFund))}
                </td>
                <td className="py-2 px-2 text-right font-mono text-xs">
                  {formatMoney(Number(c.emergencyFund))}
                </td>
                <td className="py-2 px-2 text-right font-mono font-semibold">
                  {formatMoney(t)}
                </td>
                <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                  {c.notes ?? "—"}
                </td>
                <td className="py-2 px-2">
                  {c.journalEntryId ? (
                    <JournalEntryLink id={c.journalEntryId}>
                      <Badge variant="success">Posted</Badge>
                    </JournalEntryLink>
                  ) : (
                    <Badge variant="muted">—</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New contribution</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Member</Label>
                <CustomerPicker
                  value={customerId}
                  onChange={setCustomerId}
                  required
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <NumberField
                  label="Capital Build-Up"
                  value={cbu}
                  onChange={setCbu}
                />
                <NumberField
                  label="Mortuary Fund"
                  value={mortuary}
                  onChange={setMortuary}
                />
                <NumberField
                  label="Emergency Fund"
                  value={emergency}
                  onChange={setEmergency}
                />
              </div>
              <div className="text-xs text-fg-muted">
                Total:{" "}
                <span className="font-mono text-fg">{formatMoney(total)}</span>{" "}
                — books DR Cash, CR each bucket.
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={total <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Savings ─────────────────────────────────────────────────────

function SavingsTab() {
  const list = useSavingsTxns();
  const canCreate = usePermission("coop.savings");
  const create = useCreateSavings();
  const nameOf = useCustomerName();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState(0);
  const [kind, setKind] = useState<"DEPOSIT" | "WITHDRAWAL">("DEPOSIT");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setCustomerId("");
    setAmount(0);
    setKind("DEPOSIT");
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (!customerId || amount <= 0) {
      toast.error("Member + amount required");
      return;
    }
    try {
      await create.mutateAsync({
        customerId,
        amount,
        kind,
        notes: notes || undefined,
      });
      toast.success(`Savings ${kind.toLowerCase()} recorded`);
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Savings"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Member</th>
            <th className="py-2 px-2">Kind</th>
            <th className="py-2 px-2 text-right">Amount</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((s) => (
            <tr key={s.id} className="hover:bg-hover">
              <td className="py-2 px-2 text-xs">{formatDate(s.txnDate)}</td>
              <td className="py-2 px-2">
                <MemberLedgerLink customerId={s.customerId}>
                  {nameOf(s.customerId)}
                </MemberLedgerLink>
              </td>
              <td className="py-2 px-2">
                <Badge variant={s.kind === "DEPOSIT" ? "success" : "muted"}>
                  {s.kind}
                </Badge>
              </td>
              <td
                className={`py-2 px-2 text-right font-mono ${s.kind === "DEPOSIT" ? "text-success" : "text-danger"}`}
              >
                {formatMoney(Number(s.amount))}
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                {s.notes ?? "—"}
              </td>
              <td className="py-2 px-2">
                {s.journalEntryId ? (
                  <JournalEntryLink id={s.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New savings transaction</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Member</Label>
                <CustomerPicker
                  value={customerId}
                  onChange={setCustomerId}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Kind</Label>
                  <Select
                    value={kind}
                    onValueChange={(v) => setKind(v as never)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DEPOSIT">Deposit</SelectItem>
                      <SelectItem value="WITHDRAWAL">Withdrawal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <NumberField
                  label="Amount"
                  value={amount}
                  onChange={setAmount}
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={amount <= 0 || !customerId}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Funds / Withdrawals (share much shape so generalized below) ──

function FundsTab() {
  const list = useFundTxns();
  const canCreate = usePermission("coop.funds");
  const create = useCreateFundTxn();
  const nameOf = useCustomerName();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [transactionRef, setTransactionRef] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState<string>(FUND_BUCKETS[0]);
  const [amount, setAmount] = useState(0);
  const [notes, setNotes] = useState("");

  const reset = () => {
    setCustomerId("");
    setTransactionRef("");
    setSourceOfFunds(FUND_BUCKETS[0]);
    setAmount(0);
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (amount <= 0) {
      toast.error("Amount required");
      return;
    }
    try {
      await create.mutateAsync({
        customerId: customerId || undefined,
        transactionRef: transactionRef || undefined,
        sourceOfFunds,
        amount,
        notes: notes || undefined,
      });
      toast.success("Fund transaction posted");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Fund transactions (inflows)"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Member</th>
            <th className="py-2 px-2">Source</th>
            <th className="py-2 px-2">Ref</th>
            <th className="py-2 px-2 text-right">Amount</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((f) => (
            <tr key={f.id} className="hover:bg-hover">
              <td className="py-2 px-2 text-xs">{formatDate(f.txnDate)}</td>
              <td className="py-2 px-2">
                {f.customerId ? (
                  <MemberLedgerLink customerId={f.customerId}>
                    {nameOf(f.customerId)}
                  </MemberLedgerLink>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </td>
              <td className="py-2 px-2 font-mono text-xs">{f.sourceOfFunds}</td>
              <td className="py-2 px-2 font-mono text-[10px] text-fg-muted">
                {f.transactionRef ?? "—"}
              </td>
              <td className="py-2 px-2 text-right font-mono text-success">
                {formatMoney(Number(f.amount))}
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                {f.notes ?? "—"}
              </td>
              <td className="py-2 px-2">
                {f.journalEntryId ? (
                  <JournalEntryLink id={f.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New fund transaction (inflow)</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Member (optional)</Label>
                <CustomerPicker value={customerId} onChange={setCustomerId} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <BucketSelect
                  label="Source of funds"
                  value={sourceOfFunds}
                  onChange={setSourceOfFunds}
                />
                <NumberField
                  label="Amount"
                  value={amount}
                  onChange={setAmount}
                />
              </div>
              <div>
                <Label>Transaction reference (optional)</Label>
                <Input
                  value={transactionRef}
                  onChange={(e) => setTransactionRef(e.target.value)}
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={amount <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

function WithdrawalsTab() {
  const list = useFundWithdrawals();
  const canCreate = usePermission("coop.funds");
  const create = useCreateFundWithdrawal();
  const nameOf = useCustomerName();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [sourceOfFunds, setSourceOfFunds] = useState<string>(FUND_BUCKETS[0]);
  const [amount, setAmount] = useState(0);
  const [notes, setNotes] = useState("");

  const reset = () => {
    setCustomerId("");
    setSourceOfFunds(FUND_BUCKETS[0]);
    setAmount(0);
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (amount <= 0) {
      toast.error("Amount required");
      return;
    }
    try {
      await create.mutateAsync({
        customerId: customerId || undefined,
        sourceOfFunds,
        amount,
        notes: notes || undefined,
      });
      toast.success("Withdrawal posted");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Withdrawals (outflows)"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Member</th>
            <th className="py-2 px-2">Source</th>
            <th className="py-2 px-2 text-right">Amount</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((w) => (
            <tr key={w.id} className="hover:bg-hover">
              <td className="py-2 px-2 text-xs">{formatDate(w.txnDate)}</td>
              <td className="py-2 px-2">
                {w.customerId ? (
                  <MemberLedgerLink customerId={w.customerId}>
                    {nameOf(w.customerId)}
                  </MemberLedgerLink>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </td>
              <td className="py-2 px-2 font-mono text-xs">{w.sourceOfFunds}</td>
              <td className="py-2 px-2 text-right font-mono text-danger">
                {formatMoney(Number(w.amount))}
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                {w.notes ?? "—"}
              </td>
              <td className="py-2 px-2">
                {w.journalEntryId ? (
                  <JournalEntryLink id={w.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New withdrawal</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Member (optional)</Label>
                <CustomerPicker value={customerId} onChange={setCustomerId} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <BucketSelect
                  label="Source of funds"
                  value={sourceOfFunds}
                  onChange={setSourceOfFunds}
                />
                <NumberField
                  label="Amount"
                  value={amount}
                  onChange={setAmount}
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={amount <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Expenses ────────────────────────────────────────────────────

function ExpensesTab() {
  const list = useExpenses();
  const canCreate = usePermission("coop.expense");
  const create = useCreateExpense();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [amount, setAmount] = useState(0);
  const [sourceOfFunds, setSourceOfFunds] = useState<string>(FUND_BUCKETS[5]); // GENERAL
  const [isRecurring, setIsRecurring] = useState(false);
  const [notes, setNotes] = useState("");

  const reset = () => {
    setType("");
    setAmount(0);
    setSourceOfFunds(FUND_BUCKETS[5]);
    setIsRecurring(false);
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (!type || amount <= 0) {
      toast.error("Type + amount required");
      return;
    }
    try {
      await create.mutateAsync({
        type,
        amount,
        sourceOfFunds,
        isRecurring,
        notes: notes || undefined,
      });
      toast.success("Expense posted");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Expenses"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Type</th>
            <th className="py-2 px-2 text-right">Amount</th>
            <th className="py-2 px-2">Source</th>
            <th className="py-2 px-2">Recurring</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((e) => (
            <tr key={e.id} className="hover:bg-hover">
              <td className="py-2 px-2 text-xs">{formatDate(e.txnDate)}</td>
              <td className="py-2 px-2">{e.type}</td>
              <td className="py-2 px-2 text-right font-mono text-danger">
                {formatMoney(Number(e.amount))}
              </td>
              <td className="py-2 px-2 font-mono text-xs">{e.sourceOfFunds}</td>
              <td className="py-2 px-2">
                {e.isRecurring ? (
                  <Badge variant="muted">Recurring</Badge>
                ) : (
                  <span className="text-xs text-fg-subtle">—</span>
                )}
              </td>
              <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                {e.notes ?? "—"}
              </td>
              <td className="py-2 px-2">
                {e.journalEntryId ? (
                  <JournalEntryLink id={e.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New expense</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Type</Label>
                  <Input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    placeholder="Rent, Utilities, …"
                  />
                </div>
                <NumberField
                  label="Amount"
                  value={amount}
                  onChange={setAmount}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <BucketSelect
                  label="Source of funds"
                  value={sourceOfFunds}
                  onChange={setSourceOfFunds}
                />
                <div>
                  <Label>Recurring?</Label>
                  <label className="flex items-center gap-2 mt-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isRecurring}
                      onChange={(e) => setIsRecurring(e.target.checked)}
                    />
                    Yes, repeats periodically
                  </label>
                </div>
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <p className="text-[10px] text-fg-subtle">
                Attachment uploads can be added once the document feature is
                wired in — for now, paste receipt URLs into Notes.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={!type || amount <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Other Income ────────────────────────────────────────────────

function OtherIncomeTab() {
  const list = useOtherIncome();
  const canCreate = usePermission("coop.income");
  const create = useCreateOtherIncome();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [amount, setAmount] = useState(0);
  const [sourceTo, setSourceTo] = useState<string>(FUND_BUCKETS[5]);
  const [notes, setNotes] = useState("");

  const reset = () => {
    setType("");
    setAmount(0);
    setSourceTo(FUND_BUCKETS[5]);
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (!type || amount <= 0) {
      toast.error("Type + amount required");
      return;
    }
    try {
      await create.mutateAsync({
        type,
        amount,
        sourceTo,
        notes: notes || undefined,
      });
      toast.success("Income posted");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Other income"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Date</th>
            <th className="py-2 px-2">Type</th>
            <th className="py-2 px-2 text-right">Amount</th>
            <th className="py-2 px-2">Credits to</th>
            <th className="py-2 px-2">Notes</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((o) => (
            <tr key={o.id} className="hover:bg-hover">
              <td className="py-2 px-2 text-xs">{formatDate(o.txnDate)}</td>
              <td className="py-2 px-2">{o.type}</td>
              <td className="py-2 px-2 text-right font-mono text-success">
                {formatMoney(Number(o.amount))}
              </td>
              <td className="py-2 px-2 font-mono text-xs">{o.sourceTo}</td>
              <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                {o.notes ?? "—"}
              </td>
              <td className="py-2 px-2">
                {o.journalEntryId ? (
                  <JournalEntryLink id={o.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New other income</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Type</Label>
                  <Input
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    placeholder="Donation, Dividend, …"
                  />
                </div>
                <NumberField
                  label="Amount"
                  value={amount}
                  onChange={setAmount}
                />
              </div>
              <BucketSelect
                label="Credits to (source)"
                value={sourceTo}
                onChange={setSourceTo}
              />
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={!type || amount <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Big Brother ─────────────────────────────────────────────────

function BigBrotherTab() {
  const list = useBigBrother();
  const canCreate = usePermission("coop.big_brother");
  const create = useCreateBigBrother();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [capital, setCapital] = useState(0);
  const [periodFrom, setPeriodFrom] = useState(() => todayLocalISO());
  const [periodTo, setPeriodTo] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 12);
    return todayLocalISO(d);
  });
  const [notes, setNotes] = useState("");

  const reset = () => {
    setName("");
    setAccount("");
    setCapital(0);
    setNotes("");
    setOpen(false);
  };

  const onSubmit = async () => {
    if (!name || !account || capital <= 0) {
      toast.error("Name + account + capital required");
      return;
    }
    try {
      await create.mutateAsync({
        name,
        account,
        capital,
        periodFrom: new Date(periodFrom).toISOString(),
        periodTo: new Date(periodTo).toISOString(),
        notes: notes || undefined,
      });
      toast.success("Big Brother capital recorded");
      reset();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <ListCard
      canCreate={canCreate}
      title="Big Brother (external capital)"
      onNew={() => setOpen(true)}
      isLoading={list.isLoading}
      empty={(list.data ?? []).length === 0}
    >
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Name</th>
            <th className="py-2 px-2">Account</th>
            <th className="py-2 px-2 text-right">Capital</th>
            <th className="py-2 px-2">Period</th>
            <th className="py-2 px-2">Active</th>
            <th className="py-2 px-2">Posted</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {(list.data ?? []).map((b) => (
            <tr key={b.id} className="hover:bg-hover">
              <td className="py-2 px-2">{b.name}</td>
              <td className="py-2 px-2 font-mono text-xs">{b.account}</td>
              <td className="py-2 px-2 text-right font-mono">
                {formatMoney(Number(b.capital))}
              </td>
              <td className="py-2 px-2 text-xs">
                {formatDate(b.periodFrom)} → {formatDate(b.periodTo)}
              </td>
              <td className="py-2 px-2">
                <Badge variant={b.active ? "success" : "muted"}>
                  {b.active ? "Active" : "Closed"}
                </Badge>
              </td>
              <td className="py-2 px-2">
                {b.journalEntryId ? (
                  <JournalEntryLink id={b.journalEntryId}>
                    <Badge variant="success">Posted</Badge>
                  </JournalEntryLink>
                ) : (
                  <Badge variant="muted">—</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Big Brother capital</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="NGO / parent coop"
                  />
                </div>
                <div>
                  <Label>Account / ref</Label>
                  <Input
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="acct # / ref"
                  />
                </div>
              </div>
              <NumberField
                label="Capital"
                value={capital}
                onChange={setCapital}
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Period from</Label>
                  <DatePicker value={periodFrom} onChange={setPeriodFrom} />
                </div>
                <div>
                  <Label>Period to</Label>
                  <DatePicker
                    value={periodTo}
                    onChange={setPeriodTo}
                    min={periodFrom}
                  />
                </div>
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <p className="text-[10px] text-fg-subtle">
                Books DR Cash, CR Big Brother Capital (liability). Convert to
                equity at period-end via a manual journal entry if the deal is a
                grant.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
              <Button
                onClick={onSubmit}
                loading={create.isPending}
                disabled={!name || !account || capital <= 0}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ListCard>
  );
}

// ─── Shared building blocks ──────────────────────────────────────

function ListCard({
  title,
  onNew,
  canCreate,
  children,
  isLoading,
  empty,
}: {
  title: string;
  onNew: () => void;
  /**
   * Whether the viewer may add a row. Each tab writes to a DIFFERENT
   * permission — contributions to `coop.contribute`, expenses to
   * `coop.expense`, and so on — so this is passed in rather than
   * checked here; `coop.read` alone opens the page and grants none of
   * them.
   */
  canCreate: boolean;
  children: ReactNode;
  isLoading: boolean;
  empty: boolean;
}) {
  // IMPORTANT: `children` must render in every non-loading state, even
  // when `empty === true`. Each tab puts its `<Dialog>` inside the
  // children slot, and the Dialog needs to be mounted before the
  // officer clicks "New" — otherwise the open-state toggle has nothing
  // to render against. Earlier versions only rendered children when
  // not empty, which broke the "New" button on every empty tab.
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Banknote className="h-4 w-4" />
          {title}
        </CardTitle>
        {canCreate && (
          <Button onClick={onNew}>
            <Plus className="h-3 w-3" />
            New
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <SkeletonCard />
        ) : (
          <>
            {empty && (
              <p className="text-sm text-fg-muted mb-3">
                {canCreate ? (
                  <>
                    Nothing yet — click <strong>New</strong> to record the first
                    row.
                  </>
                ) : (
                  // Don't point a read-only viewer at a button they
                  // cannot see.
                  "Nothing recorded yet."
                )}
              </p>
            )}
            {children}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        step="0.01"
        min={0}
        value={value || ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function BucketSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FUND_BUCKETS.map((b) => (
            <SelectItem key={b} value={b}>
              {b.replace("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
