import { useImportBankStatement } from "@loan/api-client";
import {
  Button,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from "@loan/ui";
import { useMemo, useState } from "react";
import { todayLocalISO } from "@loan/shared-utils";

/**
 * Import-bank-statement modal. Accepts a tiny inline CSV format:
 *
 *   txnDate,description,amount,reference,runningBalance
 *
 * (reference and runningBalance are optional; amount is positive for
 * credits, negative for debits). The first row is always the header;
 * anything else is treated as data.
 *
 * For real production use, swap the parser for `papaparse` or accept a
 * file upload. The plain-textarea path keeps zero deps and is enough to
 * verify the back-end + auto-matcher in one round-trip.
 */
export function ImportStatementDialog({ onClose }: { onClose: () => void }) {
  const importStmt = useImportBankStatement();
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [periodStart, setPeriodStart] = useState(() =>
    isoDate(thirtyDaysAgo()),
  );
  const [periodEnd, setPeriodEnd] = useState(() => isoDate(new Date()));
  const [openingBalance, setOpeningBalance] = useState(0);
  const [closingBalance, setClosingBalance] = useState(0);
  const [csv, setCsv] = useState(
    "txnDate,description,amount,reference\n2026-05-01,Inbound transfer,5000,TXN-001\n2026-05-02,Bank fee,-150,\n",
  );

  // Parse the CSV on every keystroke so the user sees the row count
  // before they hit "Import" — better than getting a 400 after the fact.
  const parsed = useMemo(() => parseCsv(csv), [csv]);

  const onSubmit = async () => {
    if (parsed.errors.length > 0) {
      toast.error(parsed.errors[0]!);
      return;
    }
    if (parsed.rows.length === 0) {
      toast.error("CSV has no data rows");
      return;
    }
    try {
      await importStmt.mutateAsync({
        label,
        bankAccount,
        periodStart: new Date(periodStart).toISOString(),
        periodEnd: new Date(periodEnd).toISOString(),
        openingBalance,
        closingBalance,
        lines: parsed.rows.map((r) => ({
          txnDate: new Date(r.txnDate).toISOString(),
          description: r.description,
          amount: r.amount,
          reference: r.reference,
          runningBalance: r.runningBalance,
        })),
      });
      toast.success(`Statement imported with ${parsed.rows.length} lines`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Import failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import bank statement</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Label</Label>
              <Input
                placeholder="BPI-Current 2026-05"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div>
              <Label>Bank account</Label>
              <Input
                placeholder="BPI-001"
                value={bankAccount}
                onChange={(e) => setBankAccount(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Period start</Label>
              <DatePicker value={periodStart} onChange={setPeriodStart} />
            </div>
            <div>
              <Label>Period end</Label>
              <DatePicker
                value={periodEnd}
                onChange={setPeriodEnd}
                min={periodStart}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Opening balance</Label>
              <Input
                type="number"
                step="0.01"
                value={openingBalance}
                onChange={(e) => setOpeningBalance(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Closing balance</Label>
              <Input
                type="number"
                step="0.01"
                value={closingBalance}
                onChange={(e) => setClosingBalance(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <Label className="flex items-center justify-between">
              <span>CSV lines</span>
              <span className="text-xs text-fg-muted">
                {parsed.rows.length} rows parsed
                {parsed.errors.length > 0 &&
                  ` · ${parsed.errors.length} error${parsed.errors.length === 1 ? "" : "s"}`}
              </span>
            </Label>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="w-full font-mono text-xs rounded-md border border-default bg-surface-2 p-2"
              spellCheck={false}
            />
            <p className="text-[10px] text-fg-subtle mt-1">
              Header row required:{" "}
              <code>txnDate,description,amount,reference,runningBalance</code>.
              Amount positive = credit, negative = debit. Last two columns
              optional.
            </p>
            {parsed.errors.length > 0 && (
              <div className="text-[10px] text-danger mt-1">
                {parsed.errors[0]}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={importStmt.isPending || parsed.rows.length === 0}
          >
            {importStmt.isPending
              ? "Importing…"
              : `Import ${parsed.rows.length} lines`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function thirtyDaysAgo(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d;
}

// Only ever called with `new Date()` or `thirtyDaysAgo()`, both
// anchored on now, so the local calendar date is the right answer.
function isoDate(d: Date): string {
  return todayLocalISO(d);
}

interface ParsedRow {
  txnDate: string;
  description: string;
  amount: number;
  reference?: string;
  runningBalance?: number;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: string[];
}

/**
 * Minimal CSV parser. Splits on newline + comma, ignores quoted strings
 * (no embedded commas in our use case). The first non-empty row is the
 * header — every row after is matched up by column index.
 */
function parseCsv(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], errors: [] };
  const header = lines[0]!.split(",").map((c) => c.trim());
  const idx = (name: string) => header.indexOf(name);
  const required = ["txnDate", "description", "amount"] as const;
  for (const r of required) {
    if (idx(r) < 0)
      return { rows: [], errors: [`Missing required column: ${r}`] };
  }
  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(",").map((c) => c.trim());
    const amount = Number(cols[idx("amount")]);
    if (!Number.isFinite(amount)) {
      errors.push(
        `Row ${i + 1}: amount "${cols[idx("amount")]}" is not a number`,
      );
      continue;
    }
    const txnDate = cols[idx("txnDate")] ?? "";
    if (!txnDate || Number.isNaN(new Date(txnDate).getTime())) {
      errors.push(`Row ${i + 1}: txnDate "${txnDate}" is not a valid date`);
      continue;
    }
    const refCol = idx("reference");
    const rbCol = idx("runningBalance");
    const reference = refCol >= 0 ? cols[refCol] || undefined : undefined;
    const rbRaw = rbCol >= 0 ? cols[rbCol] : "";
    const runningBalance =
      rbRaw && rbRaw.length > 0 ? Number(rbRaw) : undefined;
    rows.push({
      txnDate,
      description: cols[idx("description")] ?? "",
      amount,
      reference,
      runningBalance: Number.isFinite(runningBalance ?? NaN)
        ? runningBalance
        : undefined,
    });
  }
  return { rows, errors };
}
