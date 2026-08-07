import { useBulkImportCustomers } from "@loan/api-client";
import type {
  BulkCustomerImportResponse,
  BulkCustomerRowResult,
} from "@loan/api-client";
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
import { FileSpreadsheet, Trash2, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { usePermission } from "../../../hooks/use-permission";

/**
 * Bulk customer import. The CSV format matches the JSON the API
 * expects, but loose enough that operators can hand-edit in Excel:
 *
 *     firstName,lastName,dateOfBirth,phone,address,city,governmentIdType,governmentIdNumber,employmentStatus,monthlyIncome
 *     Juan,Dela Cruz,1990-04-12,09171234567,123 Sampaguita,Quezon City,NATIONAL_ID,N-1234-5678,EMPLOYED,35000
 *
 * Optional columns are surfaced in the docs above the dropzone — the
 * importer recognises every field that the customer detail form does
 * (middleName, suffix, gender, sex, civilStatus, spouseName, …).
 *
 * The flow is: drop CSV → parse client-side → preview rows → "Dry run"
 * to validate without committing → "Import" to commit. Per-row failures
 * are reported with the offending line so the operator can fix the CSV
 * and resubmit.
 */
export function BulkCustomersPage() {
  const toast = useToast();
  const bulk = useBulkImportCustomers();
  const [raw, setRaw] = useState(TEMPLATE);
  const [stopOnError, setStopOnError] = useState(false);
  const [results, setResults] = useState<BulkCustomerImportResponse | null>(
    null,
  );
  const [fileName, setFileName] = useState<string | null>(null);

  // 5 MB ceiling — same as bulk payments. A real PH cooperative onboarding
  // batch is rarely more than a few hundred rows; guard against accidental
  // mass-uploads of unrelated spreadsheets.
  const MAX_CSV_BYTES = 5 * 1024 * 1024;

  const canSubmit = usePermission("customers.write");

  const parsed = useMemo(() => parseCsv(raw), [raw]);

  const onFiles = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onerror = () => toast.error("Failed to read file");
    reader.onload = () => {
      // `readAsText` always resolves to a string; the DOM type is widened
      // to cover readAsArrayBuffer, so narrow rather than stringify —
      // String(ArrayBuffer) would silently produce "[object ArrayBuffer]".
      const text = typeof reader.result === "string" ? reader.result : "";
      setRaw(text);
      setFileName(f.name);
      setResults(null);
    };
    reader.readAsText(f);
  };

  const runImport = async (dryRun: boolean) => {
    if (parsed.rows.length === 0) {
      toast.error("No rows to import");
      return;
    }
    if (parsed.errors.length > 0) {
      toast.error(`Fix ${parsed.errors.length} parse error(s) first`);
      return;
    }
    try {
      const r = await bulk.mutateAsync({
        rows: parsed.rows,
        stopOnError,
        dryRun,
      });
      setResults(r);
      if (dryRun) {
        toast.success(
          r.failed === 0
            ? `Dry run OK — ${r.succeeded} row(s) would be created.`
            : `Dry run: ${r.succeeded} OK, ${r.failed} would fail.`,
        );
      } else {
        toast.success(`${r.succeeded} created, ${r.failed} failed`);
      }
    } catch (err) {
      toast.error((err as Error).message ?? "Import failed");
    }
  };

  const reset = () => {
    setRaw(TEMPLATE);
    setResults(null);
    setFileName(null);
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "customers-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Bulk customer import
          </CardTitle>
          <div className="text-xs text-fg-subtle mt-1">
            Drop a CSV of borrowers to onboard. Each row creates a customer with
            its own CUST-… reference number. Dry-run validates without
            committing.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadTemplate}>
            Template
          </Button>
          <Button variant="outline" size="sm" onClick={reset}>
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
          <Link
            to="/customers"
            className="text-xs text-fg-subtle underline-offset-4 hover:underline"
          >
            Customers list
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-fg-muted">
          <div className="mb-1">
            <strong className="text-fg">Required:</strong>{" "}
            <code>
              firstName, lastName, dateOfBirth, phone, address, city,
              governmentIdType, governmentIdNumber, employmentStatus,
              monthlyIncome
            </code>
            .
          </div>
          <div>
            <strong className="text-fg">Optional:</strong>{" "}
            <code>
              middleName, suffix, email, gender, sex, civilStatus,
              secondaryPhone, addressLine2, barangay, province, region,
              postalCode, spouseName, spouseDateOfBirth, spouseContact,
              spouseOccupation, employerName, position, jobTitle, hireDate,
              regularizationDate, yearsAtCurrentJob
            </code>
            .
          </div>
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
              if (fileName) setFileName(null);
              setResults(null);
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
            <div className="mt-2 overflow-x-auto">
              <table className="w-full">
                <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-1 px-2">#</th>
                    <th className="py-1 px-2">Name</th>
                    <th className="py-1 px-2">DOB</th>
                    <th className="py-1 px-2">Phone</th>
                    <th className="py-1 px-2">Gov ID</th>
                    <th className="py-1 px-2">Employment</th>
                    <th className="py-1 px-2 text-right">Income</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="text-xs">
                      <td className="py-1 px-2 text-fg-subtle">{i + 1}</td>
                      <td className="py-1 px-2">
                        {String(r.firstName ?? "")} {String(r.lastName ?? "")}
                      </td>
                      <td className="py-1 px-2 text-fg-muted">
                        {String(r.dateOfBirth ?? "")}
                      </td>
                      <td className="py-1 px-2 text-fg-muted">
                        {String(r.phone ?? "")}
                      </td>
                      <td className="py-1 px-2 text-fg-muted">
                        {String(r.governmentIdType ?? "")} ·{" "}
                        {String(r.governmentIdNumber ?? "")}
                      </td>
                      <td className="py-1 px-2 text-fg-muted">
                        {String(r.employmentStatus ?? "")}
                      </td>
                      <td className="py-1 px-2 text-right font-mono">
                        {Number(r.monthlyIncome ?? 0).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {parsed.rows.length > 50 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-2 px-2 text-center text-xs text-fg-subtle"
                      >
                        … {parsed.rows.length - 50} more rows hidden in preview
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => runImport(true)}
            disabled={
              !canSubmit ||
              bulk.isPending ||
              parsed.rows.length === 0 ||
              parsed.errors.length > 0
            }
          >
            {bulk.isPending && results === null ? "Validating…" : "Dry run"}
          </Button>
          <Button
            onClick={() => runImport(false)}
            disabled={
              !canSubmit ||
              bulk.isPending ||
              parsed.rows.length === 0 ||
              parsed.errors.length > 0
            }
          >
            <UploadCloud className="h-4 w-4" />
            {bulk.isPending
              ? "Importing…"
              : `Import ${parsed.rows.length} customer${parsed.rows.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {results && <ResultsTable results={results} />}
      </CardContent>
    </Card>
  );
}

function ResultsTable({ results }: { results: BulkCustomerImportResponse }) {
  return (
    <div className="rounded-md border border-default p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-fg-subtle">
        Results {results.dryRun && "· dry run"}
      </div>
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="success">{results.succeeded} OK</Badge>
        {results.failed > 0 && (
          <Badge variant="danger">{results.failed} failed</Badge>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
            <tr>
              <th className="py-1 px-2">#</th>
              <th className="py-1 px-2">Status</th>
              <th className="py-1 px-2">Customer</th>
              <th className="py-1 px-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {results.results.map((r) => (
              <ResultRow key={r.index} row={r} dryRun={results.dryRun} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultRow({
  row,
  dryRun,
}: {
  row: BulkCustomerRowResult;
  dryRun: boolean;
}) {
  return (
    <tr className="text-xs">
      <td className="py-1 px-2 text-fg-subtle">{row.index + 1}</td>
      <td className="py-1 px-2">
        <Badge variant={row.ok ? "success" : "danger"}>
          {row.ok ? (dryRun ? "Would create" : "Created") : "Failed"}
        </Badge>
      </td>
      <td className="py-1 px-2 font-mono">
        {row.ok && row.number ? (
          <Link
            to={`/customers/${row.number}`}
            className="text-info hover:underline"
          >
            {row.number}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td className="py-1 px-2 text-fg-muted">
        {row.ok ? (dryRun ? "OK" : "Customer created") : (row.error ?? "—")}
      </td>
    </tr>
  );
}

// ─── CSV parsing ──────────────────────────────────────────────────────

/**
 * A parsed cell. `splitCsvLine` only ever yields strings; the parser
 * coerces exactly two columns to numbers. Typing this as `unknown` (as it
 * was) forced every render site through `String(...)`, which lint
 * correctly flagged as a possible `[object Object]` — a value shape this
 * parser cannot actually produce.
 */
type CsvCell = string | number;

interface ParseResult {
  rows: Array<Record<string, CsvCell>>;
  errors: { line: number; message: string }[];
}

/**
 * Lightweight RFC-4180-ish CSV parser. Skips blank lines and lines
 * starting with `#`. The first non-empty alphabetic line is treated as
 * the header. Cell values may be unquoted, single-quoted, or
 * double-quoted; quotes inside quoted cells are doubled.
 *
 * We deliberately don't validate field types here — the API does that
 * row-by-row, and surfacing the per-row error is more useful than
 * blocking the whole batch up-front. We only coerce two numeric fields
 * (monthlyIncome + yearsAtCurrentJob) since the wire schema is strict
 * about `z.number()` on those.
 */
function parseCsv(raw: string): ParseResult {
  const rows: Array<Record<string, CsvCell>> = [];
  const errors: { line: number; message: string }[] = [];
  const lines = raw.split(/\r?\n/);
  let header: string[] | null = null;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const cols = splitCsvLine(trimmed);
    if (!header) {
      header = cols.map((c) => c.trim());
      if (header.length === 0) {
        errors.push({ line: li + 1, message: "Empty header row" });
        header = null;
      }
      continue;
    }

    const obj: Record<string, CsvCell> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i]!;
      const v = cols[i];
      if (v == null || v === "") continue;
      if (key === "monthlyIncome" || key === "yearsAtCurrentJob") {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push({
            line: li + 1,
            message: `${key} is not a number: ${v}`,
          });
          continue;
        }
        obj[key] = n;
      } else {
        obj[key] = v;
      }
    }
    if (!obj.firstName || !obj.lastName) {
      errors.push({
        line: li + 1,
        message: "firstName and lastName are required",
      });
      continue;
    }
    rows.push(obj);
  }

  return { rows, errors };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let quoteChar: '"' | "'" | "" = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === quoteChar) {
        // Doubled quote inside a quoted cell → literal quote.
        if (line[i + 1] === quoteChar) {
          cur += ch;
          i++;
        } else {
          inQuote = false;
          quoteChar = "";
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

const TEMPLATE = `# Bulk customer import template. Required columns first, optional after.
# Lines beginning with # are skipped. Delete this comment block to clean up.
firstName,middleName,lastName,suffix,dateOfBirth,gender,sex,civilStatus,phone,secondaryPhone,email,address,addressLine2,barangay,city,province,region,postalCode,governmentIdType,governmentIdNumber,employmentStatus,employerName,position,hireDate,monthlyIncome,yearsAtCurrentJob
Juan,Santos,Dela Cruz,,1990-04-12,MALE,MALE,SINGLE,09171234567,,juan@example.com,123 Sampaguita St,,Brgy Bagong Lipunan,Quezon City,Metro Manila,National Capital Region,1100,NATIONAL_ID,N-1234-5678,EMPLOYED,Globe Telecom,Field Engineer,2020-06-01,35000,5
Maria,,Reyes,,1985-09-30,FEMALE,FEMALE,MARRIED,09175558888,,,Unit 4B Mayflower Bldg,,Brgy Salcedo,Makati,Metro Manila,National Capital Region,1227,DRIVERS_LICENSE,N02-12-345678,SELF_EMPLOYED,Reyes Sari-Sari,Owner,,42000,8
`;
