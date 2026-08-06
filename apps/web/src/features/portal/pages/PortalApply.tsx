import {
  useLoanProducts,
  usePortalApplyLoan,
  useQuote,
} from "@loan/api-client";
import type {
  KycAnswers,
  LoanProduct,
  PropertyInput,
  VehicleInput,
} from "@loan/shared-types";
import {
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
import { formatMoney } from "@loan/shared-utils";
import { Camera } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { DeclarationsForm } from "../../../components/DeclarationsForm";
import { FileUpload } from "../../../components/FileUpload";

/**
 * Self-serve apply flow. Mirrors the officer LoansPage apply dialog but
 * runs as a full page and posts to /portal/loans/apply (customer-scoped).
 */
export function PortalApply() {
  const products = useLoanProducts();
  const apply = usePortalApplyLoan();
  const quote = useQuote();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Set when the borrower arrived from "Check my eligibility". Provenance
  // only — nothing on this form reads or edits it.
  const preAssessmentId = searchParams.get("preAssessmentId") ?? "";

  const [productCode, setProductCode] = useState("SALARY");
  const [principal, setPrincipal] = useState(50_000);
  const [termMonths, setTerm] = useState(12);
  const [ratePercent, setRate] = useState(24);
  const [purpose, setPurpose] = useState("");
  const [vehicle, setVehicle] = useState<VehicleInput>({
    kind: "CAR",
    make: "",
    model: "",
    year: new Date().getFullYear(),
    appraisedValue: 0,
  });
  const [property, setProperty] = useState<PropertyInput>({
    propertyType: "HOUSE_AND_LOT",
    address: "",
    city: "",
    appraisedValue: 0,
  });
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [kycAnswers, setKycAnswers] = useState<KycAnswers>({});

  const product: LoanProduct | undefined = useMemo(
    () => products.data?.find((p) => p.code === productCode),
    [products.data, productCode],
  );

  useEffect(() => {
    if (!product) return;
    setPrincipal((p) =>
      clamp(p, Number(product.minPrincipal), Number(product.maxPrincipal)),
    );
    setTerm((t) => clamp(t, product.minTermMonths, product.maxTermMonths));
    setRate(Number(product.defaultRate) * 100);
    // New product, new questionnaire — answers to the old one don't apply.
    setKycAnswers({});
    if (product.collateralKind === "VEHICLE") {
      setVehicle((v) => ({
        ...v,
        kind: productCode === "MOTORCYCLE" ? "MOTORCYCLE" : "CAR",
      }));
    }
    // Keyed on `product?.id`, not `product`: this snaps the borrower's
    // entered amounts to the newly-selected product's bounds, and must
    // fire only when the product actually changes. Depending on the object
    // would re-run on every refetch and overwrite what they typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id, productCode]);

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

  const collateralKind = product?.collateralKind ?? "NONE";
  const collateralValue =
    collateralKind === "VEHICLE"
      ? vehicle.appraisedValue
      : collateralKind === "PROPERTY"
        ? property.appraisedValue
        : 0;
  const ready =
    principal > 0 &&
    termMonths > 0 &&
    (collateralKind === "NONE" || collateralValue > 0);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    try {
      const created = await apply.mutateAsync({
        productCode,
        principal,
        termMonths,
        annualInterestRate: ratePercent / 100,
        purpose: purpose || undefined,
        vehicle: collateralKind === "VEHICLE" ? vehicle : undefined,
        property: collateralKind === "PROPERTY" ? property : undefined,
        applicationSelfieUrl: selfieUrl ?? undefined,
        kycAnswers,
        // Carried through from the eligibility check, when the borrower
        // arrived from one. Links the two records server-side.
        preAssessmentId: preAssessmentId || undefined,
      });
      toast.success(
        "Application submitted! An officer will review it shortly.",
      );
      void navigate(`/portal/loans/${created.number}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not apply");
    }
  };

  if (products.isLoading) return <SkeletonCard />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Apply for a loan</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <Field label="Product">
            <Select value={productCode} onValueChange={setProductCode}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(products.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <SelectItem key={p.id} value={p.code}>
                      {p.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          {product && (
            <div className="text-xs text-fg-muted">
              Range: {formatMoney(Number(product.minPrincipal))}–
              {formatMoney(Number(product.maxPrincipal))} ·{" "}
              {product.minTermMonths}–{product.maxTermMonths} months ·{" "}
              {(Number(product.minRate) * 100).toFixed(1)}–
              {(Number(product.maxRate) * 100).toFixed(1)}% APR
              {product.maxLoanToValue != null && (
                <>
                  {" "}
                  · LTV ≤ {(Number(product.maxLoanToValue) * 100).toFixed(0)}%
                </>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label="Principal (₱)">
              <Input
                type="number"
                min={product ? Number(product.minPrincipal) : 1}
                max={product ? Number(product.maxPrincipal) : undefined}
                value={principal}
                onChange={(e) => setPrincipal(Number(e.target.value))}
                required
              />
            </Field>
            <Field label="Term (months)">
              <Input
                type="number"
                min={product?.minTermMonths ?? 1}
                max={product?.maxTermMonths ?? 360}
                value={termMonths}
                onChange={(e) => setTerm(Number(e.target.value))}
                required
              />
            </Field>
            <Field label="APR (%)">
              <Input
                type="number"
                min={product ? Number(product.minRate) * 100 : 0}
                max={product ? Number(product.maxRate) * 100 : 60}
                step={0.25}
                value={ratePercent}
                onChange={(e) => setRate(Number(e.target.value))}
                required
              />
            </Field>
          </div>

          <Field label="Purpose">
            <Input
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Home renovation"
            />
          </Field>

          {collateralKind === "VEHICLE" && (
            <fieldset className="rounded-md border border-default p-3 space-y-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle">
                {productCode === "MOTORCYCLE" ? "Motorcycle" : "Vehicle"}
              </legend>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Make">
                  <Input
                    value={vehicle.make}
                    onChange={(e) =>
                      setVehicle({ ...vehicle, make: e.target.value })
                    }
                    required
                  />
                </Field>
                <Field label="Model">
                  <Input
                    value={vehicle.model}
                    onChange={(e) =>
                      setVehicle({ ...vehicle, model: e.target.value })
                    }
                    required
                  />
                </Field>
                <Field label="Year">
                  <Input
                    type="number"
                    min={1900}
                    max={2100}
                    value={vehicle.year}
                    onChange={(e) =>
                      setVehicle({ ...vehicle, year: Number(e.target.value) })
                    }
                    required
                  />
                </Field>
              </div>
              <Field label="Appraised value (₱)">
                <Input
                  type="number"
                  min={1}
                  value={vehicle.appraisedValue || ""}
                  onChange={(e) =>
                    setVehicle({
                      ...vehicle,
                      appraisedValue: Number(e.target.value),
                    })
                  }
                  required
                />
              </Field>
            </fieldset>
          )}

          {collateralKind === "PROPERTY" && (
            <fieldset className="rounded-md border border-default p-3 space-y-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle">
                Property
              </legend>
              <Field label="Address">
                <Input
                  value={property.address}
                  onChange={(e) =>
                    setProperty({ ...property, address: e.target.value })
                  }
                  required
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City">
                  <Input
                    value={property.city}
                    onChange={(e) =>
                      setProperty({ ...property, city: e.target.value })
                    }
                    required
                  />
                </Field>
                <Field label="Appraised value (₱)">
                  <Input
                    type="number"
                    min={1}
                    value={property.appraisedValue || ""}
                    onChange={(e) =>
                      setProperty({
                        ...property,
                        appraisedValue: Number(e.target.value),
                      })
                    }
                    required
                  />
                </Field>
              </div>
            </fieldset>
          )}

          <div className="rounded-md border border-default p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle flex items-center gap-1">
              <Camera className="h-3 w-3" />
              Selfie verification
            </div>
            <p className="text-xs text-fg-muted">
              Take a live photo so we can match it to your ID on file.
            </p>
            <FileUpload
              subdir="selfies"
              value={selfieUrl}
              onUploaded={setSelfieUrl}
              onClear={() => setSelfieUrl(null)}
              accept="image/*"
              capture="user"
              label="Take selfie"
            />
          </div>

          {/* Product-specific declarations — housing asks about the
              property, salary about employment. Answer here or later
              from the loan page; required ones must be complete before
              the loan can be approved. */}
          {(product?.kycQuestions ?? []).length > 0 && (
            <div className="rounded-md border border-default bg-surface-2 p-3 space-y-2">
              <div className="text-xs uppercase tracking-wider text-fg-subtle">
                Declarations
              </div>
              <p className="text-xs text-fg-muted">
                Questions marked * are required before your loan can be approved
                — you can also finish them later from your loan page.
              </p>
              <DeclarationsForm
                questions={product?.kycQuestions ?? []}
                answers={kycAnswers}
                onChange={setKycAnswers}
              />
            </div>
          )}

          {quote.data && (
            <div className="rounded-md border border-default bg-surface-2 p-3 text-sm">
              <div className="text-xs uppercase tracking-wider text-fg-subtle mb-1">
                Quote
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Stat
                  label="Monthly"
                  value={formatMoney(quote.data.monthlyPayment)}
                />
                <Stat
                  label="Total paid"
                  value={formatMoney(quote.data.totalPaid)}
                />
                <Stat
                  label="Interest"
                  value={formatMoney(quote.data.totalInterest)}
                />
              </div>
            </div>
          )}

          <Button
            type="submit"
            loading={apply.isPending}
            disabled={!ready}
            className="w-full"
          >
            Submit application
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-fg-muted">{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
