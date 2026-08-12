import type {
  LoanApplyInput,
  LoanProduct,
  PropertyInput,
  VehicleInput,
} from "@loan/shared-types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { Camera } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { FileUpload } from "../../../components/FileUpload";
// `useCustomers` belongs to the customers feature's data surface. Until
// that feature is migrated we read it from @loan/api-client directly;
// flip to '@/features/customers' once it lands.
import { useCustomers } from "@loan/api-client";
import { useApplyLoan, useLoanProducts, useQuote } from "../hooks";
import { AffordabilityGuardrails } from "./AffordabilityGuardrails";
import { BorrowerContextBar } from "./BorrowerContextBar";
import { KycGapWarning } from "./KycGapWarning";
import { PreDecisionPreview } from "./PreDecisionPreview";

/**
 * Product-aware "new loan application" dialog. Selecting a product type
 * loads its config from /loan-products and pre-fills principal/term/rate
 * within the product's allowed ranges. Collateral fieldsets render
 * conditionally based on the product's `collateralKind`.
 *
 * Internal to the loans feature — the parent (`LoansListPage`) just
 * passes `onClose`; the dialog owns its own form state and submission.
 */
export function NewLoanDialog({ onClose }: { onClose: () => void }) {
  const customers = useCustomers();
  const productsQuery = useLoanProducts();
  const apply = useApplyLoan();
  const quote = useQuote();
  const toast = useToast();

  const [form, setForm] = useState<FormState>({
    customerId: "",
    productCode: "SALARY",
    principal: 50_000,
    termMonths: 12,
    ratePercent: 24,
    purpose: "",
    vehicle: defaultVehicle(),
    property: defaultProperty(),
    applicationSelfieUrl: null,
  });

  const product: LoanProduct | undefined = useMemo(
    () => productsQuery.data?.find((p) => p.code === form.productCode),
    [productsQuery.data, form.productCode],
  );

  // When product changes, snap principal/term/rate into the product's range.
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
      vehicle:
        product.collateralKind === "VEHICLE"
          ? {
              ...f.vehicle,
              kind: form.productCode === "MOTORCYCLE" ? "MOTORCYCLE" : "CAR",
            }
          : f.vehicle,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  // Live quote — pass rate as decimal + product code so fees come back too.
  useEffect(() => {
    if (form.principal > 0 && form.termMonths > 0) {
      quote.mutate({
        principal: form.principal,
        termMonths: form.termMonths,
        annualInterestRate: form.ratePercent / 100,
        productCode: form.productCode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.principal, form.termMonths, form.ratePercent, form.productCode]);

  const collateralKind = product?.collateralKind ?? "NONE";
  const collateralValue =
    collateralKind === "VEHICLE"
      ? form.vehicle.appraisedValue
      : collateralKind === "PROPERTY"
        ? form.property.appraisedValue
        : 0;
  const ltv =
    collateralKind !== "NONE" && collateralValue > 0
      ? form.principal / collateralValue
      : null;

  // KYC readiness — KycGapWarning computes (base + product) docs and
  // bubbles up whether every required doc is VERIFIED.
  const [kycReady, setKycReady] = useState(false);

  const ready =
    Boolean(form.customerId) &&
    form.principal > 0 &&
    form.termMonths > 0 &&
    (collateralKind === "NONE" || collateralValue > 0) &&
    kycReady;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    const payload: LoanApplyInput = {
      customerId: form.customerId,
      productCode: form.productCode,
      principal: form.principal,
      termMonths: form.termMonths,
      annualInterestRate: form.ratePercent / 100,
      purpose: form.purpose || undefined,
      vehicle: collateralKind === "VEHICLE" ? form.vehicle : undefined,
      property: collateralKind === "PROPERTY" ? form.property : undefined,
      applicationSelfieUrl: form.applicationSelfieUrl ?? undefined,
    };
    try {
      await apply.mutateAsync(payload);
      toast.success("Application submitted");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not apply");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New loan application</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer">
              {(id) => (
                <Select
                  value={form.customerId}
                  onValueChange={(v) => setForm({ ...form, customerId: v })}
                >
                  <SelectTrigger id={id}>
                    <SelectValue placeholder="— select a customer —" />
                  </SelectTrigger>
                  <SelectContent>
                    {(customers.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.firstName} {c.lastName} · {c.kycStatus}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Product">
              {(id) => (
                <Select
                  value={form.productCode}
                  onValueChange={(next) => {
                    const p = productsQuery.data?.find((x) => x.code === next);
                    setForm({
                      ...form,
                      productCode: next,
                      ratePercent: p
                        ? Number(p.defaultRate) * 100
                        : form.ratePercent,
                    });
                  }}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(productsQuery.data ?? [])
                      .filter((p) => p.active)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.code}>
                          {p.name}
                        </SelectItem>
                      ))}
                    {productsQuery.data?.length === 0 && (
                      <SelectItem value="SALARY">
                        Salary (no products configured)
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>

          {product && (
            <div className="text-xs text-fg-muted -mt-1">
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

          {/*
            Smart context bar — surfaces income, KYC status, credit score,
            DORSI flag, and prior-loan history the moment the officer
            picks a customer. Removes the "open another tab" tax.
          */}
          {form.customerId && (
            <BorrowerContextBar customerId={form.customerId} />
          )}

          {/*
            KYC gap warning — checklist of required docs for THIS product.
            Bubbles readiness up via setKycReady; submit stays disabled
            until every required doc is VERIFIED.
          */}
          {form.customerId && (
            <KycGapWarning
              customerId={form.customerId}
              productRequiredDocs={product?.requiredKycDocs ?? []}
              onReadinessChange={setKycReady}
            />
          )}

          <div className="grid grid-cols-3 gap-3">
            <Field label="Principal (₱)">
              <Input
                type="number"
                min={product ? Number(product.minPrincipal) : 1}
                max={product ? Number(product.maxPrincipal) : undefined}
                value={form.principal}
                onChange={(e) =>
                  setForm({ ...form, principal: Number(e.target.value) })
                }
                required
              />
            </Field>
            <Field label="Term (months)">
              <Input
                type="number"
                min={product?.minTermMonths ?? 1}
                max={product?.maxTermMonths ?? 360}
                value={form.termMonths}
                onChange={(e) =>
                  setForm({ ...form, termMonths: Number(e.target.value) })
                }
                required
              />
            </Field>
            <Field label="APR (%)">
              <Input
                type="number"
                min={product ? Number(product.minRate) * 100 : 0}
                max={product ? Number(product.maxRate) * 100 : 60}
                step={0.25}
                value={form.ratePercent}
                onChange={(e) =>
                  setForm({ ...form, ratePercent: Number(e.target.value) })
                }
                required
              />
            </Field>
          </div>

          {/*
            Affordability + DORSI guardrails. Lives just below the
            principal/term/rate row so the EMI / DTI / safe-principal
            feedback is visible as the officer dials in the numbers.
          */}
          {form.customerId && (
            <AffordabilityGuardrails
              customerId={form.customerId}
              principal={form.principal}
              termMonths={form.termMonths}
              ratePercent={form.ratePercent}
            />
          )}

          <Field label="Purpose">
            <Input
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              placeholder="e.g. Working capital, second car, refinance"
            />
          </Field>

          {collateralKind === "VEHICLE" && (
            <VehicleFieldset
              value={form.vehicle}
              onChange={(v) => setForm({ ...form, vehicle: v })}
              productCode={form.productCode}
            />
          )}
          {collateralKind === "PROPERTY" && (
            <PropertyFieldset
              value={form.property}
              onChange={(p) => setForm({ ...form, property: p })}
            />
          )}

          <div className="rounded-md border border-default p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle flex items-center gap-1">
              <Camera className="h-3 w-3" />
              Application selfie
            </div>
            <p className="text-xs text-fg-muted">
              Live capture of the borrower for face-match against the ID on
              file. Optional but strongly recommended for fraud signal.
            </p>
            <FileUpload
              subdir="selfies"
              value={form.applicationSelfieUrl}
              onUploaded={(url) =>
                setForm({ ...form, applicationSelfieUrl: url })
              }
              onClear={() => setForm({ ...form, applicationSelfieUrl: null })}
              accept="image/*"
              capture="user"
              label="Take/upload selfie"
            />
          </div>

          {quote.data && (
            <div className="rounded-md border border-default bg-surface-2 p-3 text-sm space-y-2">
              <div className="flex items-center justify-between text-xs uppercase tracking-wider text-fg-subtle">
                <span>Quote</span>
                <span>
                  {quote.data.method === "FLAT"
                    ? "Flat interest"
                    : "Declining balance"}{" "}
                  · {quote.data.frequency.toLowerCase()} ·{" "}
                  {quote.data.installments} installments
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <Stat
                  label="Per period"
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
                {ltv != null && (
                  <Stat label="LTV" value={`${(ltv * 100).toFixed(1)}%`} />
                )}
              </div>
              {quote.data.fees.total > 0 && (
                <div className="border-t border-default pt-2 grid grid-cols-4 gap-2">
                  <Stat
                    label="Processing fee"
                    value={formatMoney(quote.data.fees.processing)}
                  />
                  <Stat
                    label="Doc stamp"
                    value={formatMoney(quote.data.fees.documentary)}
                  />
                  <Stat
                    label="Total fees"
                    value={formatMoney(quote.data.fees.total)}
                  />
                  <Stat
                    label="Net to customer"
                    value={formatMoney(quote.data.fees.netDisbursement)}
                  />
                </div>
              )}
              {ltv != null &&
                product?.maxLoanToValue != null &&
                ltv > Number(product.maxLoanToValue) && (
                  <div className="text-xs text-danger">
                    LTV exceeds product ceiling of{" "}
                    {(Number(product.maxLoanToValue) * 100).toFixed(0)}%.
                  </div>
                )}
            </div>
          )}

          {/*
            Pre-decisioning preview — runs the rules engine on the form
            values via /loans/dry-run (500ms debounce). The officer sees
            the verdict + reason + matched rule before Submit, so
            "submit and wait for rejection" stops being a workflow.
          */}
          {form.customerId && (
            <PreDecisionPreview
              customerId={form.customerId}
              productCode={form.productCode}
              principal={form.principal}
              termMonths={form.termMonths}
              ratePercent={form.ratePercent}
            />
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={apply.isPending} disabled={!ready}>
              Submit application
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Internal types / helpers ───────────────────────────────────────────────

interface FormState {
  customerId: string;
  productCode: string;
  /** Principal in pesos (whole units, not centavos). */
  principal: number;
  termMonths: number;
  /** APR as a percent in the UI (12.5 = 12.5%); converted to decimal on submit. */
  ratePercent: number;
  purpose: string;
  vehicle: VehicleInput;
  property: PropertyInput;
  applicationSelfieUrl: string | null;
}

function defaultVehicle(): VehicleInput {
  return {
    kind: "CAR",
    make: "",
    model: "",
    year: new Date().getFullYear(),
    appraisedValue: 0,
  };
}

function defaultProperty(): PropertyInput {
  return {
    propertyType: "HOUSE_AND_LOT",
    address: "",
    city: "",
    appraisedValue: 0,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function VehicleFieldset({
  value,
  onChange,
  productCode,
}: {
  value: VehicleInput;
  onChange: (next: VehicleInput) => void;
  productCode: string;
}) {
  return (
    <fieldset className="rounded-md border border-default p-3 space-y-3">
      <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle">
        {productCode === "MOTORCYCLE" ? "Motorcycle" : "Vehicle"} collateral
      </legend>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Make">
          <Input
            value={value.make}
            onChange={(e) => onChange({ ...value, make: e.target.value })}
            required
          />
        </Field>
        <Field label="Model">
          <Input
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
            required
          />
        </Field>
        <Field label="Year">
          <Input
            type="number"
            min={1900}
            max={2100}
            value={value.year}
            onChange={(e) =>
              onChange({ ...value, year: Number(e.target.value) })
            }
            required
          />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Plate #">
          <Input
            value={value.plateNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, plateNumber: e.target.value })
            }
          />
        </Field>
        <Field label="Chassis #">
          <Input
            value={value.chassisNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, chassisNumber: e.target.value })
            }
          />
        </Field>
        <Field label="Appraised value (₱)">
          <Input
            type="number"
            min={1}
            value={value.appraisedValue || ""}
            onChange={(e) =>
              onChange({ ...value, appraisedValue: Number(e.target.value) })
            }
            required
          />
        </Field>
      </div>
    </fieldset>
  );
}

function PropertyFieldset({
  value,
  onChange,
}: {
  value: PropertyInput;
  onChange: (next: PropertyInput) => void;
}) {
  return (
    <fieldset className="rounded-md border border-default p-3 space-y-3">
      <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle">
        Property collateral
      </legend>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Property type">
          {(id) => (
            <Select
              value={value.propertyType}
              onValueChange={(v) => onChange({ ...value, propertyType: v })}
            >
              <SelectTrigger id={id}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HOUSE_AND_LOT">House &amp; Lot</SelectItem>
                <SelectItem value="CONDO">Condominium</SelectItem>
                <SelectItem value="LOT_ONLY">Lot Only</SelectItem>
                <SelectItem value="COMMERCIAL">Commercial</SelectItem>
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Title #">
          <Input
            value={value.titleNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, titleNumber: e.target.value })
            }
          />
        </Field>
        <Field label="Tax dec #">
          <Input
            value={value.taxDecNumber ?? ""}
            onChange={(e) =>
              onChange({ ...value, taxDecNumber: e.target.value })
            }
          />
        </Field>
      </div>
      <Field label="Address">
        <Input
          value={value.address}
          onChange={(e) => onChange({ ...value, address: e.target.value })}
          required
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="City">
          <Input
            value={value.city}
            onChange={(e) => onChange({ ...value, city: e.target.value })}
            required
          />
        </Field>
        <Field label="Area (sqm)">
          <Input
            type="number"
            min={0}
            step={0.01}
            value={value.areaSqm ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                areaSqm: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </Field>
        <Field label="Appraised value (₱)">
          <Input
            type="number"
            min={1}
            value={value.appraisedValue || ""}
            onChange={(e) =>
              onChange({ ...value, appraisedValue: Number(e.target.value) })
            }
            required
          />
        </Field>
      </div>
    </fieldset>
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
