import { useBulkImportUsers } from "@loan/api-client";
import type {
  BulkUserImportResponse,
  BulkUserRowResult,
  UserRole,
} from "@loan/shared-types";
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
import { FileSpreadsheet, Trash2, UploadCloud, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../../../providers/auth";
import { findArticle, TourButton } from "../../help";

/**
 * Bulk staff onboarding. CSV-driven: each row spawns one User row plus
 * optional secondary role assignments. Mirrors the bulk customer page's
 * dropzone + dry-run + per-row results table so operators only have to
 * learn the flow once.
 *
 * The CSV columns mirror `bulkUserRowSchema` on the API side:
 *
 *     email,name,password,role,customerId?,extraRoles?
 *
 *   - `role` is the primary role: ADMIN / LOAN_OFFICER / ACCOUNTANT / CUSTOMER
 *   - `customerId` is required *only* when role === CUSTOMER (links to an
 *     existing customer row 1:1)
 *   - `extraRoles` is a free-form comma-list of additional role keys to
 *     assign post-create (e.g. "BRANCH_MANAGER,COLLECTIONS_LEAD"). The
 *     API attaches each one through the standard assign path so audit
 *     rows are still emitted per assignment.
 *
 * Gating: ADMIN only — staff onboarding affects auth boundaries and we
 * don't want loan officers handing out roles.
 */
export function BulkUsersPage() {
  const { user } = useAuth();
  const toast = useToast();
  const bulk = useBulkImportUsers();
  const [raw, setRaw] = useState(TEMPLATE);
  const [stopOnError, setStopOnError] = useState(false);
  const [results, setResults] = useState<BulkUserImportResponse | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // 2 MB is enough for ~5000 user rows; the server caps the batch at 500
  // anyway, but a generous file-size limit avoids spurious rejections
  // when the operator includes long comment headers.
  const MAX_CSV_BYTES = 2 * 1024 * 1024;

  const canSubmit = user?.role === "ADMIN";

  const parsed = useMemo(() => parseCsv(raw), [raw]);

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
            ? `Dry run OK — ${r.succeeded} user(s) would be created.`
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
    a.download = "users-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card data-tour="bulk-users-panel">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Bulk user onboarding
          </CardTitle>
          <div className="text-xs text-fg-subtle mt-1">
            Drop a CSV to create staff accounts in one go. Dry-run validates
            every row without writing anything — use it as a preview before
            committing. Admin only.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TourButton
            tourId="bulk-users"
            steps={findArticle("bulk-users")?.tour ?? []}
          />
          <Button variant="outline" size="sm" onClick={downloadTemplate}>
            <FileSpreadsheet className="h-3 w-3" />
            Template
          </Button>
          <Button variant="outline" size="sm" onClick={reset}>
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
          <Link
            to="/users"
            className="text-xs text-fg-subtle underline-offset-4 hover:underline"
          >
            Users list
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-xs text-fg-muted">
          <div className="mb-1">
            <strong className="text-fg">Required:</strong>{" "}
            <code>email, name, password, role</code>. <code>role</code> is one
            of <code>ADMIN</code>, <code>LOAN_OFFICER</code>,{" "}
            <code>ACCOUNTANT</code>, <code>CUSTOMER</code>.
          </div>
          <div>
            <strong className="text-fg">Optional:</strong>{" "}
            <code>customerId</code> (required when role is CUSTOMER — UUID of
            the existing customer row), <code>extraRoles</code> (comma-separated
            additional role keys to assign post-create).
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
                <span className="font-medium text-sky-300">{fileName}</span>
                <span className="text-fg-muted">
                  {" "}
                  loaded — drop another to replace
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-sky-300">
                  Drop your CSV here
                </span>
                <span className="text-fg-muted"> or click to browse</span>
              </>
            )
          }
          hint={<>.csv up to 2&nbsp;MB · paste below works too</>}
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
            className="w-full font-mono text-xs rounded-md border border-white/15 bg-white/[0.04] p-2"
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
          <ul className="text-xs space-y-1 text-rose-300">
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
                    <th className="py-1 px-2">Email</th>
                    <th className="py-1 px-2">Name</th>
                    <th className="py-1 px-2">Role</th>
                    <th className="py-1 px-2">Extra roles</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {parsed.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} className="text-xs">
                      <td className="py-1 px-2 text-fg-subtle">{i + 1}</td>
                      <td className="py-1 px-2 font-mono">
                        {String(r.email ?? "")}
                      </td>
                      <td className="py-1 px-2">{String(r.name ?? "")}</td>
                      <td className="py-1 px-2">
                        <Badge variant="muted">{String(r.role ?? "")}</Badge>
                      </td>
                      <td className="py-1 px-2 text-fg-muted">
                        {r.extraRoles ? (
                          String(r.extraRoles)
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {parsed.rows.length > 50 && (
                    <tr>
                      <td
                        colSpan={5}
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

        <div className="flex flex-wrap gap-2" data-tour="bulk-users-actions">
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
              : `Import ${parsed.rows.length} user${parsed.rows.length === 1 ? "" : "s"}`}
          </Button>
        </div>

        {!canSubmit && (
          <div className="text-xs text-amber-300/90">
            Only ADMIN users may import staff accounts in bulk. Ask an admin to
            run this for you, or use the per-user create form on the Users page.
          </div>
        )}

        {results && <ResultsTable results={results} />}
      </CardContent>
    </Card>
  );
}

function ResultsTable({ results }: { results: BulkUserImportResponse }) {
  return (
    <div className="rounded-md border border-white/10 p-3 space-y-2">
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
              <th className="py-1 px-2">Email</th>
              <th className="py-1 px-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
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
  row: BulkUserRowResult;
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
        {row.ok ? row.email : <span className="text-fg-subtle">—</span>}
      </td>
      <td className="py-1 px-2 text-fg-muted">
        {row.ok ? (dryRun ? "OK" : "User created") : row.error}
      </td>
    </tr>
  );
}

// ─── CSV parsing ──────────────────────────────────────────────────────

interface ParseResult {
  rows: Array<{
    email: string;
    name: string;
    password: string;
    role: UserRole;
    customerId?: string;
    extraRoles?: string;
  }>;
  errors: { line: number; message: string }[];
}

/**
 * Same shape as the bulk-customer parser: blank lines and `#`-prefixed
 * lines are dropped; the first surviving line is the header. We don't
 * type-coerce anything — every column reaches the API as a string and
 * `bulkUserRowSchema` is responsible for validation.
 *
 * The one local sanity check is per-row: every row must have email +
 * name + password + role, since those are universally required and
 * catching them client-side keeps the API from being the one to flag
 * obvious typos.
 */
function parseCsv(raw: string): ParseResult {
  const rows: ParseResult["rows"] = [];
  const errors: { line: number; message: string }[] = [];
  const lines = raw.split(/\r?\n/);
  let header: string[] | null = null;

  const VALID_ROLES: ReadonlyArray<UserRole> = [
    "ADMIN",
    "LOAN_OFFICER",
    "ACCOUNTANT",
    "CUSTOMER",
  ];

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

    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i]!;
      const v = cols[i];
      if (v == null || v === "") continue;
      obj[key] = v;
    }

    const missing = ["email", "name", "password", "role"].filter(
      (k) => !obj[k],
    );
    if (missing.length > 0) {
      errors.push({
        line: li + 1,
        message: `Missing required column(s): ${missing.join(", ")}`,
      });
      continue;
    }
    if (!VALID_ROLES.includes(obj.role as UserRole)) {
      errors.push({
        line: li + 1,
        message: `Unknown role "${obj.role}" (expected one of ${VALID_ROLES.join(", ")})`,
      });
      continue;
    }

    rows.push({
      email: obj.email!,
      name: obj.name!,
      password: obj.password!,
      role: obj.role as UserRole,
      customerId: obj.customerId,
      extraRoles: obj.extraRoles,
    });
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

const TEMPLATE = `# Bulk user onboarding template. Lines starting with # are skipped.
# Required: email, name, password, role
# Optional: customerId (only for role=CUSTOMER), extraRoles (comma list)
email,name,password,role,customerId,extraRoles
alice.officer@example.com,Alice Officer,ChangeMe!2026,LOAN_OFFICER,,
bob.accountant@example.com,Bob Accountant,ChangeMe!2026,ACCOUNTANT,,"BRANCH_MANAGER"
`;
