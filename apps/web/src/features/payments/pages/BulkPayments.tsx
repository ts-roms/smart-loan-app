import { useRecordPaymentsBulk } from "@loan/api-client";
import type { BulkPaymentRow, BulkPaymentRowResult } from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FileDropzone,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { FileSpreadsheet, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { usePermission } from "../../../hooks/use-permission";

/**
 * Bulk payment recording. The CSV format is the same shape the API expects:
 *
 *     loanNumber,amount,paidOn,reference
 *     LN-2026-000001,5000,2026-05-20,GCASH-ABC123
 *     LN-2026-000002,3500,,
 *
 * `paidOn` defaults to today. `reference` is optional. Comments (#…) and
 * blank lines are skipped. Use `loanId` instead of `loanNumber` if you have
 * UUIDs.
 *
 * Submission is per-row: each row is independent, so a single bad row
 * doesn't block the rest. Failed rows are shown with their error.
 */
export function BulkPaymentsPage() {
  const toast = useToast();
  const bulk = useRecordPaymentsBulk();
  const [raw, setRaw] = useState("loanNumber,amount,paidOn,reference\n");
  const [stopOnError, setStopOnError] = useState(false);
  const [results, setResults] = useState<BulkPaymentRowResult[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const canSubmit = usePermission("payments.bulk");

  const parsed = useMemo(() => parseCsv(raw), [raw]);

  // 5 MB ceiling — way more than a sane payments CSV would ever need, and
  // a guard against accidentally dropping a 200MB Excel export.
  const MAX_CSV_BYTES = 5 * 1024 * 1024;

  const onFiles = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onerror = () => toast.error("Failed to read file");
    reader.onload = () => {
      // See BulkCustomers — narrow rather than stringify so an
      // ArrayBuffer result can't become "[object ArrayBuffer]".
      const text = typeof reader.result === "string" ? reader.result : "";
      setRaw(text);
      setFileName(f.name);
      setResults(null);
    };
    reader.readAsText(f);
  };

  const onSubmit = async () => {
    if (parsed.rows.length === 0) {
      toast.error("No rows to post");
      return;
    }
    if (parsed.errors.length > 0) {
      toast.error(`Fix ${parsed.errors.length} parse error(s) first`);
      return;
    }
    try {
      const r = await bulk.mutateAsync({ rows: parsed.rows, stopOnError });
      setResults(r.results);
      toast.success(`${r.succeeded} posted, ${r.failed} failed`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const reset = () => {
    setRaw("loanNumber,amount,paidOn,reference\n");
    setResults(null);
    setFileName(null);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Bulk payments
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reset}>
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-fg-muted">
          Format: <code>loanNumber,amount,paidOn,reference</code>. Header row
          optional. Use <code>loanId</code> in the header instead of{" "}
          <code>loanNumber</code> if you have UUIDs.
        </div>

        <FileDropzone
          accept=".csv,text/csv,text/plain"
          maxSize={MAX_CSV_BYTES}
          onFiles={onFiles}
          onReject={(reason) => toast.error(reason)}
          label={
            fileName ? (
              <>
                <span className="font-medium text-info">{fileName}</span>
                <span className="text-fg-muted">
                  {" "}
                  loaded — drop another to replace
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-info">
                  Drop your CSV here
                </span>
                <span className="text-fg-muted"> or click to browse</span>
              </>
            )
          }
          hint={<>.csv up to 5&nbsp;MB · paste below works too</>}
        />

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              CSV contents
            </span>
            <span className="text-[10px] text-fg-subtle">
              {raw.split(/\r?\n/).filter((l) => l.trim().length > 0).length}{" "}
              non-empty line(s)
            </span>
          </div>
          <textarea
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              // Drop the filename label as soon as the user edits — the
              // textarea now reflects their own input, not the file.
              if (fileName) setFileName(null);
            }}
            rows={12}
            className="w-full font-mono text-xs rounded-md border border-default bg-surface-2 p-2"
            spellCheck={false}
          />
        </div>

        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-3">
            <Badge variant={parsed.errors.length > 0 ? "danger" : "muted"}>
              {parsed.rows.length} row(s) parsed
            </Badge>
            {parsed.errors.length > 0 && (
              <Badge variant="danger">
                {parsed.errors.length} parse error(s)
              </Badge>
            )}
            {parsed.totalAmount > 0 && (
              <span className="text-fg-muted">
                Total:{" "}
                <span className="font-mono">
                  {formatMoney(parsed.totalAmount)}
                </span>
              </span>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={stopOnError}
              onChange={(e) => setStopOnError(e.target.checked)}
            />
            Stop on first error
          </label>
        </div>

        {parsed.errors.length > 0 && (
          <ul className="text-xs space-y-1 text-danger">
            {parsed.errors.map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        )}

        {parsed.rows.length > 0 && (
          <details className="text-sm" open>
            <summary className="cursor-pointer text-xs uppercase tracking-wider text-fg-subtle">
              Preview ({parsed.rows.length} rows)
            </summary>
            <table className="w-full mt-2">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-1 px-2">#</th>
                  <th className="py-1 px-2">Loan</th>
                  <th className="py-1 px-2 text-right">Amount</th>
                  <th className="py-1 px-2">Paid on</th>
                  <th className="py-1 px-2">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {parsed.rows.map((r, i) => (
                  <tr key={i} className="text-xs">
                    <td className="py-1 px-2 text-fg-subtle">{i + 1}</td>
                    <td className="py-1 px-2 font-mono">
                      {r.loanNumber ?? r.loanId}
                    </td>
                    <td className="py-1 px-2 text-right font-mono">
                      {formatMoney(r.amount)}
                    </td>
                    <td className="py-1 px-2 text-fg-muted">
                      {r.paidOn ?? "today"}
                    </td>
                    <td className="py-1 px-2 text-fg-muted">
                      {r.reference ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        <div>
          <Button
            onClick={onSubmit}
            disabled={
              !canSubmit ||
              bulk.isPending ||
              parsed.rows.length === 0 ||
              parsed.errors.length > 0
            }
          >
            {bulk.isPending
              ? "Posting…"
              : `Post ${parsed.rows.length} payment${parsed.rows.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {results && (
          <div className="rounded-md border border-default p-3">
            <div className="text-xs uppercase tracking-wider text-fg-subtle mb-2">
              Results
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-1 px-2">#</th>
                  <th className="py-1 px-2">Loan</th>
                  <th className="py-1 px-2">Status</th>
                  <th className="py-1 px-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {results.map((r) => (
                  <tr key={r.index} className="text-xs">
                    <td className="py-1 px-2 text-fg-subtle">{r.index + 1}</td>
                    <td className="py-1 px-2 font-mono">{r.loanNumber}</td>
                    <td className="py-1 px-2">
                      <Badge variant={r.ok ? "success" : "danger"}>
                        {r.ok ? "Posted" : "Failed"}
                      </Badge>
                    </td>
                    <td className="py-1 px-2 text-fg-muted">
                      {r.ok ? `payment ${r.paymentId?.slice(0, 8)}` : r.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ParseResult {
  rows: BulkPaymentRow[];
  errors: { line: number; message: string }[];
  totalAmount: number;
}

function parseCsv(raw: string): ParseResult {
  const rows: BulkPaymentRow[] = [];
  const errors: { line: number; message: string }[] = [];
  let total = 0;
  const lines = raw.split(/\r?\n/);
  let headerCols: string[] | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(",").map((c) => c.trim());
    // First non-empty line containing alpha looks like a header.
    if (!headerCols && cols.some((c) => /[a-z]/i.test(c) && !/^\d/.test(c))) {
      headerCols = cols.map((c) => c.toLowerCase());
      continue;
    }
    const cols2 = cols.map((c) => (c === "" ? undefined : c));
    const map: Record<string, string | undefined> = {};
    if (headerCols) {
      for (let i = 0; i < headerCols.length; i++) {
        const key = headerCols[i]!;
        map[key] = cols2[i];
      }
    } else {
      map.loannumber = cols2[0];
      map.amount = cols2[1];
      map.paidon = cols2[2];
      map.reference = cols2[3];
    }
    const loanNumber = map.loannumber ?? map["loan_number"];
    const loanId = map.loanid ?? map["loan_id"];
    const amount = Number(map.amount);
    if (!loanNumber && !loanId) {
      errors.push({ line: li + 1, message: "Missing loanNumber or loanId" });
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ line: li + 1, message: `Invalid amount: ${map.amount}` });
      continue;
    }
    rows.push({
      loanNumber,
      loanId,
      amount,
      paidOn: map.paidon ?? map["paid_on"] ?? undefined,
      reference: map.reference,
    });
    total += amount;
  }
  return { rows, errors, totalAmount: Math.round(total * 100) / 100 };
}
