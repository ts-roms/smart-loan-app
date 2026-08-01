import {
  useAddNote,
  useCreatePromise,
  useLoan,
  useLoanNotes,
  useLoanPromises,
  useResolvePromise,
} from "@loan/api-client";
import type { CollectionNoteType, PromiseStatus } from "@loan/shared-types";
import {
  Badge,
  Button,
  DatePicker,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonLine,
  useToast,
} from "@loan/ui";
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  ArrowUpRight,
  Calendar,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  PiggyBank,
  StickyNote,
  Truck,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "../../loans";

const NOTE_TYPES: Array<{
  value: CollectionNoteType;
  label: string;
  icon: typeof Phone;
}> = [
  { value: "CALL", label: "Call", icon: Phone },
  { value: "SMS", label: "SMS", icon: MessageSquare },
  { value: "EMAIL", label: "Email", icon: Mail },
  { value: "VISIT", label: "Visit", icon: Truck },
  { value: "OTHER", label: "Other", icon: StickyNote },
];

/**
 * Click-to-inspect wrapper for a loan id from the collections queue.
 * Opens a focused case-management drawer with overdue stats, active PTPs,
 * note timeline, and inline forms to add notes / promises.
 *
 * Usage:
 *   <CollectionsCaseLink id={l.id}>{l.number}</CollectionsCaseLink>
 */
export function CollectionsCaseLink({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left text-sky-300 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 rounded"
          aria-label="Open collections case"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-w-xl">
        <CollectionsCaseInspector id={id} />
      </DrawerContent>
    </Drawer>
  );
}

function CollectionsCaseInspector({ id }: { id: string }) {
  const loan = useLoan(id);
  const notes = useLoanNotes(id);
  const promises = useLoanPromises(id);
  const addNote = useAddNote();
  const createPromise = useCreatePromise();
  const resolvePromise = useResolvePromise();
  const toast = useToast();

  const [noteType, setNoteType] = useState<CollectionNoteType>("CALL");
  const [noteBody, setNoteBody] = useState("");

  const [ptpAmount, setPtpAmount] = useState(0);
  const [ptpDate, setPtpDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [ptpNote, setPtpNote] = useState("");

  if (loan.isLoading) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Collections case</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <SkeletonLine />
          <SkeletonLine />
        </DrawerBody>
      </>
    );
  }
  if (!loan.data) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Collections case</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <p className="text-sm text-white/55">Loan not found.</p>
        </DrawerBody>
      </>
    );
  }

  const l = loan.data;
  const openSchedule = (l.schedule ?? []).filter((s) => !s.paidInFullAt);
  // Net off both paid-to-date legs: an open installment can carry partial
  // interest as well as partial principal.
  const outstanding = openSchedule.reduce(
    (sum, s) =>
      sum +
      (Number(s.totalDue) - Number(s.principalPaid) - Number(s.interestPaid)),
    0,
  );
  const now = new Date();
  const overdueRows = openSchedule.filter((s) => new Date(s.dueDate) < now);
  const earliestOverdue = overdueRows[0];
  const daysOverdue = earliestOverdue
    ? Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(earliestOverdue.dueDate).getTime()) /
            86_400_000,
        ),
      )
    : 0;
  const lastPayments = (l.payments ?? [])
    .slice()
    .sort((a, b) => new Date(b.paidOn).getTime() - new Date(a.paidOn).getTime())
    .slice(0, 5);

  const activePromises = (promises.data ?? []).filter(
    (p) => p.status === "PROMISED",
  );

  const onAddNote = async () => {
    if (!noteBody.trim()) {
      toast.error("Add a body");
      return;
    }
    try {
      await addNote.mutateAsync({
        loanId: id,
        type: noteType,
        body: noteBody.trim(),
      });
      setNoteBody("");
      toast.success("Note added");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onCreatePromise = async () => {
    if (ptpAmount <= 0) {
      toast.error("Amount > 0 required");
      return;
    }
    try {
      await createPromise.mutateAsync({
        loanId: id,
        amount: ptpAmount,
        promisedDate: new Date(ptpDate).toISOString(),
        note: ptpNote || undefined,
      });
      setPtpAmount(0);
      setPtpNote("");
      toast.success("Promise to pay recorded");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onResolve = async (id: string, status: PromiseStatus) => {
    try {
      await resolvePromise.mutateAsync({ id, loanId: l.id, status });
      toast.success(`Promise marked ${status.toLowerCase()}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <PhoneCall className="h-5 w-5 mt-0.5 text-rose-300" />
          <div className="flex-1 min-w-0">
            <DrawerTitle className="font-mono">{l.number}</DrawerTitle>
            <DrawerDescription>
              <LoanStatusBadge status={l.status} />
              <span className="ml-2 text-rose-300 font-mono">
                {daysOverdue} day{daysOverdue === 1 ? "" : "s"} overdue
              </span>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* Overdue stats */}
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Outstanding"
            value={formatMoney(outstanding)}
            accent="rose"
          />
          <Stat label="Overdue rows" value={String(overdueRows.length)} />
          <Stat label="Days overdue" value={String(daysOverdue)} />
        </div>

        {/* Active PTPs */}
        {activePromises.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5 flex items-center gap-1">
              <Calendar className="h-3 w-3" />
              Active promises to pay
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
              {activePromises.map((p) => (
                <div key={p.id} className="px-2.5 py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-mono font-semibold">
                        {formatMoney(Number(p.amount))}
                      </div>
                      <div className="text-[10px] text-white/55">
                        by {formatDate(p.promisedDate)}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onResolve(p.id, "HONORED")}
                      >
                        Honored
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onResolve(p.id, "BROKEN")}
                      >
                        Broken
                      </Button>
                    </div>
                  </div>
                  {p.note && <div className="mt-1 text-white/65">{p.note}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* New PTP */}
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-white/45 mb-2 flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Record new promise
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={ptpAmount || ""}
                onChange={(e) => setPtpAmount(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>By date</Label>
              <DatePicker value={ptpDate} onChange={setPtpDate} />
            </div>
          </div>
          <div className="mt-2">
            <Label>Note (optional)</Label>
            <Input
              value={ptpNote}
              onChange={(e) => setPtpNote(e.target.value)}
              placeholder="Context, channel, …"
            />
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              onClick={onCreatePromise}
              disabled={createPromise.isPending || ptpAmount <= 0}
            >
              {createPromise.isPending ? "Saving…" : "Record promise"}
            </Button>
          </div>
        </div>

        {/* Recent payments */}
        {lastPayments.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5 flex items-center gap-1">
              <PiggyBank className="h-3 w-3" />
              Recent payments
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
              {lastPayments.map((p) => (
                <div
                  key={p.id}
                  className="px-2.5 py-1.5 text-xs flex items-center justify-between"
                >
                  <div className="text-white/65">
                    {formatDate(p.paidOn)}
                    {p.reference && (
                      <span className="ml-1 font-mono text-[10px] text-white/45">
                        {p.reference}
                      </span>
                    )}
                  </div>
                  <div className="font-mono font-semibold text-emerald-300">
                    {formatMoney(Number(p.amount))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Note timeline */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5 flex items-center gap-1">
            <StickyNote className="h-3 w-3" />
            Note timeline
          </div>
          {notes.isLoading ? (
            <SkeletonLine />
          ) : (notes.data ?? []).length === 0 ? (
            <p className="text-xs text-white/55">No notes yet.</p>
          ) : (
            <div className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
              {(notes.data ?? []).map((n) => (
                <div key={n.id} className="px-2.5 py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <Badge variant="muted">{n.type}</Badge>
                    <span className="text-[10px] text-white/45">
                      {formatDateTime(n.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-white/85 whitespace-pre-wrap">
                    {n.body}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* New note */}
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-white/45 mb-2 flex items-center gap-1">
            <StickyNote className="h-3 w-3" />
            Add note
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>Channel</Label>
              <Select
                value={noteType}
                onValueChange={(v) => setNoteType(v as CollectionNoteType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Body</Label>
              <Input
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Customer answered, will pay Friday…"
              />
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              onClick={onAddNote}
              disabled={addNote.isPending || !noteBody.trim()}
            >
              {addNote.isPending ? "Saving…" : "Add note"}
            </Button>
          </div>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <Link
            to={`/loans/${l.number}`}
            className="inline-flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open full loan detail
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "rose";
}) {
  const color = accent === "rose" ? "text-rose-300" : "text-white";
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className={`font-mono text-sm mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}
