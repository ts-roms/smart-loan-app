import {
  useLoanProducts,
  usePortalPreAssess,
  usePortalPreAssessments,
  useQuote,
} from "@loan/api-client";
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
import { Gauge } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

// Pulled from features/pre-assessment so the borrower and the officer are
// looking at one rendering of the same saved verdict — `tone` is the only
// difference, and it drops the internal underwriting detail.
import { PreAssessmentVerdict } from "../../pre-assessment";

/**
 * "Check my eligibility" — the borrower's own pre-assessment.
 *
 * Runs the same rules the officer's assessment does, against the caller's
 * real record: their credit score, AML status and KYC pack are all in
 * play, so the answer is a genuine preview rather than an estimate.
 *
 * Rendered with `tone="borrower"`, which drops the internal underwriting
 * detail (which rule fired, anomaly flags, the context echo) — a borrower
 * should see the outcome and what to do about it, not the policy.
 *
 * A result is deliberately NOT a decision, and nothing here creates an
 * application. The hand-off to /portal/apply is a separate, explicit step.
 */
export function PortalPreAssess() {
  const products = useLoanProducts();
  const preAssess = usePortalPreAssess();
  const history = usePortalPreAssessments();
  const quote = useQuote();
  const toast = useToast();
  const navigate = useNavigate();

  const [productCode, setProductCode] = useState("SALARY");
  const [principal, setPrincipal] = useState(50_000);
  const [termMonths, setTerm] = useState(12);
  const [ratePercent, setRate] = useState(24);
  const [result, setResult] = useState<PreAssessment | null>(null);

  const product: LoanProduct | undefined = useMemo(
    () => products.data?.find((p) => p.code === productCode),
    [products.data, productCode],
  );

  // Snap the entered amounts into the selected product's bounds, and take
  // its default rate. Keyed on `product?.id` for the reason spelled out in
  // PortalApply: depending on the object would re-run on every refetch and
  // overwrite what the borrower typed.
  useEffect(() => {
    if (!product) return;
    setPrincipal((p) =>
      clamp(p, Number(product.minPrincipal), Number(product.maxPrincipal)),
    );
    setTerm((t) => clamp(t, product.minTermMonths, product.maxTermMonths));
    setRate(Number(product.defaultRate) * 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, productCode]);

  // Live repayment figure, so the borrower sees the monthly cost next to
  // the verdict rather than having to go to the apply page to find out.
  useEffect(() => {
    if (principal > 0 && termMonths > 0) {
      quote.mutate({
        principal,
        termMonths,
        annualInterestRate: ratePercent / 100,
        productCode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, termMonths, ratePercent, productCode]);

  const ready = principal > 0 && termMonths > 0 && Boolean(productCode);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    try {
      const assessment = await preAssess.mutateAsync({
        productCode,
        principal,
        termMonths,
        annualInterestRate: ratePercent / 100,
      });
      setResult(assessment);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not run the check");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-brand" />
            Check my eligibility
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-fg-muted">
            See how a loan would be assessed before you apply. This doesn&apos;t
            create an application and doesn&apos;t affect your record — you can
            run it as often as you like.
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Loan type</span>
                <Select value={productCode} onValueChange={setProductCode}>
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
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Amount</span>
                <Input
                  type="number"
                  min={0}
                  value={principal}
                  onChange={(e) => setPrincipal(Number(e.target.value))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Term (months)</span>
                <Input
                  type="number"
                  min={1}
                  value={termMonths}
                  onChange={(e) => setTerm(Number(e.target.value))}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-fg-muted">Rate (% p.a.)</span>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={ratePercent}
                  onChange={(e) => setRate(Number(e.target.value))}
                />
              </label>
            </div>

            {quote.data && (
              <p className="text-xs text-fg-muted">
                Estimated repayment:{" "}
                <span className="font-semibold text-fg">
                  {formatMoney(quote.data.monthlyPayment)}
                </span>{" "}
                per month over {quote.data.installments} installments.
              </p>
            )}

            <Button
              type="submit"
              loading={preAssess.isPending}
              disabled={!ready}
            >
              Check eligibility
            </Button>
          </form>

          {result && (
            <div className="space-y-2">
              <PreAssessmentVerdict assessment={result} tone="borrower" />
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    navigate(`/portal/apply?preAssessmentId=${result.id}`)
                  }
                >
                  Apply for this loan
                </Button>
                {/* The most common reason a check comes back short. Sending
                    them straight to the upload page beats making them find
                    it from a sentence. */}
                {result.gates && !result.gates.kycComplete && (
                  <Button
                    variant="secondary"
                    onClick={() => navigate("/portal/kyc")}
                  >
                    Upload documents
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Previous checks</CardTitle>
        </CardHeader>
        <CardContent>
          {history.isLoading ? (
            <SkeletonCard />
          ) : (history.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">
              You haven&apos;t run a check yet.
            </p>
          ) : (
            <ul className="divide-y divide-default text-sm">
              {(history.data ?? []).map((a) => (
                <li
                  key={a.id}
                  className="py-2 flex items-center justify-between gap-3 flex-wrap"
                >
                  <div>
                    <div className="font-medium">
                      {formatMoney(a.principal)} · {a.termMonths} months
                    </div>
                    <div className="text-xs text-fg-muted">
                      {a.productCode} · {formatDate(a.createdAt)} ·{" "}
                      <span className="font-mono">{a.number}</span>
                    </div>
                  </div>
                  <Badge variant={VERDICT_VARIANT[a.verdict]}>
                    {VERDICT_LABEL[a.verdict]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const VERDICT_VARIANT = {
  APPROVE: "success",
  REVIEW: "warning",
  REJECT: "danger",
} as const;

/** Borrower-facing wording — the raw enum reads as a decision. */
const VERDICT_LABEL = {
  APPROVE: "Likely to qualify",
  REVIEW: "Officer review",
  REJECT: "Unlikely to qualify",
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
