import type { LoanProduct, PreAssessment } from "@loan/shared-types";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { Gauge, Search, UserPlus } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { PhoneInput } from "../../../components/PhoneInput";
import { Link, useNavigate } from "react-router-dom";

import { PreAssessmentVerdict } from "../components/PreAssessmentVerdict";
import {
  useCustomers,
  useLoanProducts,
  usePreAssessments,
  useRunPreAssessment,
  type PreAssessmentFilter,
} from "../hooks";

/**
 * Staff pre-assessment. Answers "would this be approved?" before anyone
 * fills in an application, for two kinds of subject:
 *
 *   • An existing customer — their credit score, AML status and KYC pack
 *     are all in play, so the verdict matches what /loans/dry-run would
 *     say inside the new-loan wizard.
 *   • A walk-in prospect with no customer record — only the figures the
 *     officer types. The engine sees no score, no screening and no
 *     documents, so the verdict is conservative and labelled INDICATIVE.
 *
 * Every run is saved. That's the point of this page over the wizard's
 * live preview: what a branch quoted at the counter is a record, and it
 * has to still be explainable after the rules are next edited.
 */
export function PreAssessmentsPage() {
  const customers = useCustomers();
  const products = useLoanProducts();
  const run = useRunPreAssessment();
  const toast = useToast();
  const navigate = useNavigate();

  const [mode, setMode] = useState<"CUSTOMER" | "PROSPECT">("CUSTOMER");
  const [form, setForm] = useState<FormState>({
    customerId: "",
    prospectName: "",
    prospectPhone: "",
    prospectEmail: "",
    monthlyIncome: 25_000,
    applicantAge: 30,
    productCode: "",
    principal: 50_000,
    termMonths: 12,
    ratePercent: 24,
  });
  const [result, setResult] = useState<PreAssessment | null>(null);
  const [filter, setFilter] = useState<PreAssessmentFilter>({});

  const history = usePreAssessments(filter);

  const product: LoanProduct | undefined = useMemo(
    () => products.data?.find((p) => p.code === form.productCode),
    [products.data, form.productCode],
  );

  // Default to the first product once the catalog loads, then snap the
  // amounts into whichever product is selected. Same behaviour as the
  // new-loan wizard, so an officer doesn't have to learn two sets of
  // rules about which numbers are legal.
  useEffect(() => {
    const first = products.data?.[0];
    if (first && !form.productCode) {
      setForm((f) => ({ ...f, productCode: first.code }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.data]);

  useEffect(() => {
    if (!product) return;
    setForm((f) => ({
      ...f,
      principal: clamp(
        f.principal,
        Number(product.minPrincipal),
        Number(product.maxPrincipal),
      ),
      termMonths: clamp(
        f.termMonths,
        product.minTermMonths,
        product.maxTermMonths,
      ),
      ratePercent: clamp(
        f.ratePercent,
        Number(product.minRate) * 100,
        Number(product.maxRate) * 100,
      ),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  const subjectReady =
    mode === "CUSTOMER"
      ? Boolean(form.customerId)
      : form.prospectName.trim().length > 0;
  const ready =
    subjectReady &&
    Boolean(form.productCode) &&
    form.principal > 0 &&
    form.termMonths > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    try {
      const assessment = await run.mutateAsync(
        mode === "CUSTOMER"
          ? {
              customerId: form.customerId,
              productCode: form.productCode,
              principal: form.principal,
              termMonths: form.termMonths,
              annualInterestRate: form.ratePercent / 100,
            }
          : {
              prospectName: form.prospectName.trim(),
              // Empty optionals are omitted rather than sent as "" — the
              // API validates prospectEmail as an email, and "" isn't one.
              prospectPhone: form.prospectPhone.trim() || undefined,
              prospectEmail: form.prospectEmail.trim() || undefined,
              monthlyIncome: form.monthlyIncome,
              applicantAge: form.applicantAge,
              productCode: form.productCode,
              principal: form.principal,
              termMonths: form.termMonths,
              annualInterestRate: form.ratePercent / 100,
            },
      );
      setResult(assessment);
      toast.success(`Assessed · ${assessment.number}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Assessment failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-brand" />
            Pre-assessment
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-fg-muted">
            Runs the live decision rules against the figures below without
            creating an application. Every run is saved and can be quoted back
            by its reference number.
          </p>

          {/* Subject mode. The two modes take genuinely different inputs,
              so this is a switch rather than a set of optional fields. */}
          <div className="flex gap-2">
            <ModeButton
              active={mode === "CUSTOMER"}
              onClick={() => setMode("CUSTOMER")}
              icon={<Search className="h-3 w-3" />}
              label="Existing customer"
            />
            <ModeButton
              active={mode === "PROSPECT"}
              onClick={() => setMode("PROSPECT")}
              icon={<UserPlus className="h-3 w-3" />}
              label="Walk-in prospect"
            />
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {mode === "CUSTOMER" ? (
              <Field label="Customer">
                <Select
                  value={form.customerId}
                  onValueChange={(v) => setForm({ ...form, customerId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {(customers.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.firstName} {c.lastName} · {c.kycStatus}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Name">
                  <Input
                    value={form.prospectName}
                    onChange={(e) =>
                      setForm({ ...form, prospectName: e.target.value })
                    }
                    placeholder="Juan Dela Cruz"
                    required
                  />
                </Field>
                <Field label="Phone">
                  {/* A prospect isn't a customer yet — a walk-in who
                      won't give a number still gets assessed. */}
                  <PhoneInput
                    value={form.prospectPhone}
                    onChange={(v) => setForm({ ...form, prospectPhone: v })}
                    optional
                  />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    value={form.prospectEmail}
                    onChange={(e) =>
                      setForm({ ...form, prospectEmail: e.target.value })
                    }
                    placeholder="optional"
                  />
                </Field>
                <Field label="Declared monthly income">
                  <Input
                    type="number"
                    min={0}
                    value={form.monthlyIncome}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        monthlyIncome: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Age">
                  <Input
                    type="number"
                    min={16}
                    max={120}
                    value={form.applicantAge}
                    onChange={(e) =>
                      setForm({ ...form, applicantAge: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Field label="Product">
                <Select
                  value={form.productCode}
                  onValueChange={(v) => setForm({ ...form, productCode: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {(products.data ?? []).map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Principal">
                <Input
                  type="number"
                  min={0}
                  value={form.principal}
                  onChange={(e) =>
                    setForm({ ...form, principal: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Term (months)">
                <Input
                  type="number"
                  min={1}
                  value={form.termMonths}
                  onChange={(e) =>
                    setForm({ ...form, termMonths: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="Rate (% p.a.)">
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={form.ratePercent}
                  onChange={(e) =>
                    setForm({ ...form, ratePercent: Number(e.target.value) })
                  }
                />
              </Field>
            </div>

            <Button type="submit" disabled={!ready || run.isPending}>
              {run.isPending ? "Assessing…" : "Run assessment"}
            </Button>
          </form>

          {result && (
            <div className="space-y-2">
              <PreAssessmentVerdict assessment={result} />
              {/* The natural next step when it looks good. The wizard needs
                  a customer, so a prospect has to be created first. */}
              {result.customerId && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    navigate(
                      `/loans/new?customerId=${result.customerId}&preAssessmentId=${result.id}`,
                    )
                  }
                >
                  Start an application
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent assessments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search reference or name…"
              className="max-w-xs"
              value={filter.q ?? ""}
              onChange={(e) =>
                setFilter({ ...filter, q: e.target.value || undefined })
              }
            />
            <Select
              value={filter.verdict ?? "ALL"}
              onValueChange={(v) =>
                setFilter({
                  ...filter,
                  verdict:
                    v === "ALL"
                      ? undefined
                      : (v as PreAssessmentFilter["verdict"]),
                })
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All verdicts</SelectItem>
                <SelectItem value="APPROVE">Approve</SelectItem>
                <SelectItem value="REVIEW">Review</SelectItem>
                <SelectItem value="REJECT">Reject</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filter.source ?? "ALL"}
              onValueChange={(v) =>
                setFilter({
                  ...filter,
                  source:
                    v === "ALL"
                      ? undefined
                      : (v as PreAssessmentFilter["source"]),
                })
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All sources</SelectItem>
                <SelectItem value="OFFICER">Staff-run</SelectItem>
                <SelectItem value="PORTAL">Borrower self-check</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {history.isLoading ? (
            <SkeletonCard />
          ) : (history.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">No assessments yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-2 px-2">Reference</th>
                    <th className="py-2 px-2">Subject</th>
                    <th className="py-2 px-2">Product</th>
                    <th className="py-2 px-2 text-right">Principal</th>
                    <th className="py-2 px-2">Verdict</th>
                    <th className="py-2 px-2">Basis</th>
                    <th className="py-2 px-2">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {(history.data ?? []).map((a) => (
                    <tr key={a.id} className="hover:bg-hover">
                      <td className="py-2 px-2 font-mono text-xs">
                        {a.number}
                      </td>
                      {/* Customer-backed rows link to the profile; a
                          walk-in prospect has no page to link to. */}
                      <td className="py-2 px-2">
                        {a.customer ? (
                          <Link
                            to={`/customers/${a.customer.number}`}
                            className="text-info hover:underline"
                          >
                            {a.customer.firstName} {a.customer.lastName}
                          </Link>
                        ) : (
                          subjectLabel(a)
                        )}
                      </td>
                      <td className="py-2 px-2 text-fg-muted text-xs">
                        {a.productCode}
                      </td>
                      <td className="py-2 px-2 text-right">
                        {formatMoney(a.principal)}
                      </td>
                      <td className="py-2 px-2">
                        <Badge variant={VERDICT_VARIANT[a.verdict]}>
                          {a.verdict}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs text-fg-muted">
                        {a.basis === "FULL" ? "Full" : "Indicative"}
                      </td>
                      <td className="py-2 px-2 text-xs text-fg-muted">
                        {formatDate(a.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface FormState {
  customerId: string;
  prospectName: string;
  prospectPhone: string;
  prospectEmail: string;
  monthlyIncome: number;
  applicantAge: number;
  productCode: string;
  principal: number;
  termMonths: number;
  /** Percent in the UI, decimal on the wire. */
  ratePercent: number;
}

const VERDICT_VARIANT = {
  APPROVE: "success",
  REVIEW: "warning",
  REJECT: "danger",
} as const;

/**
 * Whose assessment this is. A staff-run row for a walk-in has only the
 * typed name; a customer-backed row shows the joined record, falling back
 * to the id when the customer has since been erased.
 */
function subjectLabel(a: PreAssessment): string {
  if (a.customer) return `${a.customer.firstName} ${a.customer.lastName}`;
  if (a.prospectName) return a.prospectName;
  return a.customerId ? "(customer)" : "(unnamed prospect)";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}
    </label>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs ${
        active
          ? "border-brand bg-brand/10 text-fg"
          : "border-default text-fg-muted hover:bg-hover"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
