import { useAddCoMaker, useCustomers } from "@loan/api-client";
import type {
  CoMakerInput,
  CoMakerRole,
  LoanApplyInput,
  LoanProduct,
  PropertyInput,
  VehicleInput,
} from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Stepper,
  type StepperStep,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  CreditCard,
  Save,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { FileUpload } from "../../../components/FileUpload";
import { AffordabilityGuardrails } from "../components/AffordabilityGuardrails";
import { BorrowerContextBar } from "../components/BorrowerContextBar";
import { findArticle, TourButton } from "../../help";
import {
  defaultProperty,
  defaultVehicle,
  PropertyFieldset,
  VehicleFieldset,
} from "../components/CollateralFieldsets";
import { KycGapWarning } from "../components/KycGapWarning";
import { PreDecisionPreview } from "../components/PreDecisionPreview";
import {
  useApplyLoan,
  useCreateLoanDraft,
  useDeleteLoanDraft,
  useLoanDraft,
  useLoanProducts,
  useQuote,
  useUpdateLoanDraft,
} from "../hooks";

// ─── Step definitions ─────────────────────────────────────────────────

/**
 * Step ids in wizard order. Module-scoped rather than rebuilt per render:
 * the contents are constant, and as a local it became a changing
 * dependency of the `completedIds` memo every pass.
 * Kept parallel to STEPS below and to the keys of `validity`.
 */
const STEP_KEYS = [
  "borrower",
  "product",
  "collateral",
  "verification",
  "review",
] as const;

const STEPS: StepperStep[] = [
  { id: "borrower", label: "Borrower", hint: "Pick the customer" },
  { id: "product", label: "Product & Terms", hint: "Principal, term, APR" },
  { id: "collateral", label: "Collateral & Co-makers", hint: "Security" },
  { id: "verification", label: "Verification", hint: "Selfie + purpose" },
  { id: "review", label: "Review", hint: "Submit" },
];

// ─── Form state ───────────────────────────────────────────────────────

interface CoMakerDraft extends CoMakerInput {
  /** Local tracking id so React lists are stable. Not persisted. */
  _key: string;
}

interface FormState {
  customerId: string;
  productCode: string;
  principal: number;
  termMonths: number;
  ratePercent: number;
  purpose: string;
  vehicle: VehicleInput;
  property: PropertyInput;
  applicationSelfieUrl: string | null;
  coMakers: CoMakerDraft[];
}

const initialForm: FormState = {
  customerId: "",
  productCode: "",
  principal: 50_000,
  termMonths: 12,
  ratePercent: 24,
  purpose: "",
  vehicle: defaultVehicle(),
  property: defaultProperty(),
  applicationSelfieUrl: null,
  coMakers: [],
};

// ─── Page component ───────────────────────────────────────────────────

/**
 * 5-step loan application wizard. Replaces NewLoanDialog for officers.
 * State lives in a single FormState; each step renders a slice. The
 * wizard supports drafts (auto-saved on Next, manual via "Save draft"
 * button) so officers can pause and resume from another device.
 *
 * Route shape: `/loans/new` for a fresh draft, `/loans/new/:draftId`
 * to resume. The drafts list at `/loans/drafts` links here.
 */
export function NewLoanPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const params = useParams<{ draftId?: string }>();
  const [searchParams] = useSearchParams();

  // Either path param (/loans/new/:draftId) or query (?customerId=…)
  const draftId = params.draftId ?? null;
  const seedCustomerId = searchParams.get("customerId") ?? "";

  // Form + step state. Initialized from the seed customer when starting
  // fresh from a customer detail page; overwritten on draft load.
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>({
    ...initialForm,
    customerId: seedCustomerId,
  });
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(draftId);

  // Auto-load draft contents on mount when ?draftId provided.
  const draftQuery = useLoanDraft(draftId);
  const didHydrateRef = useRef(false);
  useEffect(() => {
    if (didHydrateRef.current) return;
    if (draftQuery.data) {
      const persisted = draftQuery.data.formState as Partial<FormState> | null;
      if (persisted) {
        setForm((curr) => ({ ...curr, ...persisted }));
      }
      setStep(Math.min(draftQuery.data.lastStep, STEPS.length - 1));
      setCurrentDraftId(draftQuery.data.id);
      didHydrateRef.current = true;
    }
  }, [draftQuery.data]);

  const customers = useCustomers();
  const productsQuery = useLoanProducts();
  const apply = useApplyLoan();
  const quote = useQuote();
  const addCoMaker = useAddCoMaker();
  const createDraft = useCreateLoanDraft();
  const updateDraft = useUpdateLoanDraft();
  const deleteDraft = useDeleteLoanDraft();

  const product: LoanProduct | undefined = useMemo(
    () => productsQuery.data?.find((p) => p.code === form.productCode),
    [productsQuery.data, form.productCode],
  );
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

  // Live quote — same wiring as the old dialog.
  useEffect(() => {
    if (form.principal > 0 && form.termMonths > 0 && form.productCode) {
      quote.mutate({
        principal: form.principal,
        termMonths: form.termMonths,
        annualInterestRate: form.ratePercent / 100,
        productCode: form.productCode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.principal, form.termMonths, form.ratePercent, form.productCode]);

  // Snap principal/term/rate when product changes — same heuristic as the
  // old dialog. Avoids invalid values that the API would reject.
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

  // ── KYC readiness — bubbled up from the gap warning component ─────
  const [kycReady, setKycReady] = useState(false);

  // ─── Per-step validation ──────────────────────────────────────────
  // Each step has a gate; Next is disabled when the gate is false. The
  // gates also flow into the stepper's "completed" set so already-valid
  // steps are clickable.
  const validity = useMemo(() => {
    return {
      borrower: Boolean(form.customerId),
      product:
        Boolean(form.customerId) &&
        Boolean(form.productCode) &&
        form.principal > 0 &&
        form.termMonths > 0 &&
        form.ratePercent >= 0 &&
        kycReady,
      collateral:
        collateralKind === "NONE" ||
        (collateralKind === "VEHICLE" &&
          form.vehicle.make.length > 0 &&
          collateralValue > 0) ||
        (collateralKind === "PROPERTY" &&
          form.property.address.length > 0 &&
          collateralValue > 0),
      verification: true, // selfie + purpose both optional
      review: true,
    };
  }, [form, kycReady, collateralKind, collateralValue]);
  const currentValid = validity[STEP_KEYS[step]!];
  const completedIds = useMemo(() => {
    const set = new Set<string>();
    for (let i = 0; i < step; i++) {
      if (validity[STEP_KEYS[i]!]) set.add(STEPS[i]!.id);
    }
    return set;
  }, [step, validity]);

  // ─── Draft persistence ────────────────────────────────────────────

  const persistDraft = async (lastStep = step) => {
    const patch = {
      customerId: form.customerId || null,
      productCode: form.productCode || null,
      lastStep,
      formState: form,
    };
    if (currentDraftId) {
      await updateDraft.mutateAsync({ id: currentDraftId, patch });
    } else {
      const created = await createDraft.mutateAsync(patch);
      setCurrentDraftId(created.id);
    }
  };

  const onSaveDraft = async () => {
    try {
      await persistDraft();
      toast.success("Draft saved");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save draft");
    }
  };

  const onDiscardDraft = async () => {
    if (currentDraftId) {
      try {
        await deleteDraft.mutateAsync(currentDraftId);
        toast.success("Draft discarded");
      } catch {
        // soft-fail; navigate anyway
      }
    }
    void navigate("/loans");
  };

  // ─── Step navigation ──────────────────────────────────────────────

  const onNext = async () => {
    if (!currentValid) return;
    const next = Math.min(step + 1, STEPS.length - 1);
    setStep(next);
    // Best-effort silent save on every forward step so a crash / refresh
    // doesn't lose progress. Errors are swallowed — manual "Save draft"
    // remains available.
    void persistDraft(next).catch(() => {});
  };
  const onBack = () => setStep(Math.max(0, step - 1));

  // ─── Final submit ─────────────────────────────────────────────────

  const onSubmit = async () => {
    if (!validity.product || !validity.collateral) {
      toast.error("Fix earlier steps before submitting");
      return;
    }
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
      const created = await apply.mutateAsync(payload);
      // Attach co-makers one by one. We do this AFTER the loan is
      // created (so we have an id); failures here don't roll back the
      // loan — operator can re-add via the loan detail page.
      for (const cm of form.coMakers) {
        const { _key, ...input } = cm;
        await addCoMaker
          .mutateAsync({ loanId: created.id, ...input })
          .catch((err) => {
            toast.error(
              `Loan saved, but co-maker "${cm.fullName}" failed: ${(err as Error).message}`,
            );
          });
      }
      // Consume the draft on success.
      if (currentDraftId) {
        await deleteDraft.mutateAsync(currentDraftId).catch(() => {});
      }
      toast.success("Application submitted");
      // Navigate via the new "LN-..." reference number rather than the UUID
      // — operator URLs are now expected to be human-readable everywhere.
      void navigate(`/loans/${created.number}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not apply");
    }
  };

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      {/* Page header — title + persistent draft / discard controls */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-info" />
            New loan application
            {currentDraftId && (
              <Badge variant="muted" title={`Draft id: ${currentDraftId}`}>
                Draft
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <TourButton
              tourId="loan-apply-wizard"
              steps={findArticle("loan-apply-wizard")?.tour ?? []}
            />
            <span data-tour="wizard-save">
              <Button
                size="sm"
                variant="outline"
                onClick={onSaveDraft}
                disabled={createDraft.isPending || updateDraft.isPending}
              >
                <Save className="h-3 w-3" />
                {createDraft.isPending || updateDraft.isPending
                  ? "Saving…"
                  : "Save draft"}
              </Button>
            </span>
            <Button size="sm" variant="ghost" onClick={onDiscardDraft}>
              <Trash2 className="h-3 w-3" />
              {currentDraftId ? "Discard" : "Cancel"}
            </Button>
          </div>
        </CardHeader>
        <CardContent data-tour="wizard-stepper">
          <Stepper
            steps={STEPS}
            currentIndex={step}
            completedIds={completedIds}
            onStepClick={(i) => setStep(i)}
            trailing={
              <span className="text-xs text-fg-muted">
                Step {step + 1} of {STEPS.length}
              </span>
            }
          />
        </CardContent>
      </Card>

      {/* Sticky borrower context once a customer is selected.
          Hidden on step 1 (the customer picker IS the focus there). */}
      {step > 0 && form.customerId && (
        <BorrowerContextBar customerId={form.customerId} />
      )}

      {/* Step body */}
      <Card data-tour="wizard-body">
        <CardContent className="p-6 space-y-4">
          {step === 0 && (
            <Step1Borrower
              form={form}
              setForm={setForm}
              customers={customers.data ?? []}
            />
          )}
          {step === 1 && (
            <Step2ProductTerms
              form={form}
              setForm={setForm}
              products={productsQuery.data ?? []}
              product={product}
              quote={quote.data}
              ltv={ltv}
              onKycReadinessChange={setKycReady}
            />
          )}
          {step === 2 && (
            <Step3CollateralCoMakers
              form={form}
              setForm={setForm}
              product={product}
            />
          )}
          {step === 3 && <Step4Verification form={form} setForm={setForm} />}
          {step === 4 && (
            <Step5Review
              form={form}
              product={product}
              quote={quote.data}
              ltv={ltv}
            />
          )}
        </CardContent>
      </Card>

      {/*
        Navigation footer. The Next / Back labels name the destination
        stage so officers always know where the click will take them —
        no more "wait, what was step 3 again?" mid-application.
      */}
      <div className="flex items-center justify-between" data-tour="wizard-nav">
        <Button variant="outline" onClick={onBack} disabled={step === 0}>
          <ArrowLeft className="h-4 w-4" />
          {step > 0 ? `Back · ${STEPS[step - 1]!.label}` : "Back"}
        </Button>
        {step < STEPS.length - 1 ? (
          <span data-tour="wizard-next">
            <Button onClick={onNext} disabled={!currentValid}>
              {`Next · ${STEPS[step + 1]!.label}`}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </span>
        ) : (
          <Button
            onClick={onSubmit}
            disabled={
              apply.isPending || !validity.product || !validity.collateral
            }
          >
            <CheckCircle2 className="h-4 w-4" />
            {apply.isPending ? "Submitting…" : "Submit application"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Step 1 — Borrower
// ═══════════════════════════════════════════════════════════════════

function Step1Borrower({
  form,
  setForm,
  customers,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  customers: Array<{
    id: string;
    number?: string;
    firstName: string;
    lastName: string;
    kycStatus: string;
    hasLoans: boolean;
    hasDefaulted: boolean;
  }>;
}) {
  // A new application usually goes to someone with nothing running, so the
  // idle suggestion list ranks in three tiers off the server-computed
  // flags: clear first, then customers already on the books, then anyone
  // with a prior default. Nobody is filtered out — typing still finds
  // every customer — they just don't get the top-10 slots by default.
  const ranked = useMemo(() => {
    const tier = (c: (typeof customers)[number]) =>
      c.hasDefaulted ? 2 : c.hasLoans ? 1 : 0;
    // Array#sort is stable, so the API's newest-first order survives
    // inside each tier.
    return [...customers].sort((a, b) => tier(a) - tier(b));
  }, [customers]);

  // Resolve the selected customer for the SearchInput value prop. We keep
  // the form state shape unchanged (just the UUID) — only the picker
  // chrome upgrades from a fixed Select to a typeahead.
  const selectedCustomer = form.customerId
    ? (customers.find((c) => c.id === form.customerId) ?? null)
    : null;

  return (
    <div className="space-y-3">
      <StepHeading
        title="Who is applying?"
        subtitle="Pick the borrower. Their KYC, credit score, and prior-loan history will load below."
      />
      <Field label="Customer">
        {/* Typeahead picker — operators with hundreds of customers couldn't
            scroll a flat Select. Focusing the field suggests up to 10
            borrowers with nothing running; typing searches everyone. */}
        <SearchInput
          items={ranked}
          suggestOnFocus
          maxResults={10}
          value={selectedCustomer}
          onSelect={(c) => setForm((f) => ({ ...f, customerId: c?.id ?? "" }))}
          matches={(c, q) =>
            c.firstName.toLowerCase().includes(q) ||
            c.lastName.toLowerCase().includes(q) ||
            (c.number ?? "").toLowerCase().includes(q)
          }
          getDisplayLabel={(c) => `${c.firstName} ${c.lastName}`}
          getItemKey={(c) => c.id}
          placeholder="Search by name or reference"
          emptyMessage={(q) => `No customers match “${q}”.`}
          renderSuggestion={(c) => (
            <span
              className={cn(
                "flex items-center justify-between gap-3 min-w-0",
                // The whole row goes red, not just the tag — a prior
                // default is the one thing an officer must not miss while
                // skimming, and it outranks the "nothing running" nudge
                // that put this customer near the top of the list.
                c.hasDefaulted && "text-danger",
              )}
            >
              <span className="min-w-0 truncate">
                {c.firstName} {c.lastName}
              </span>
              <span
                className={cn(
                  "flex items-center gap-2 shrink-0 text-[10px] font-mono",
                  c.hasDefaulted ? "text-danger" : "text-fg-subtle",
                )}
              >
                {c.number && <span>{c.number}</span>}
                <span>{c.kycStatus}</span>
                {c.hasDefaulted && (
                  <span className="font-semibold">PRIOR DEFAULT</span>
                )}
                {/* Says "no live loan", not "never borrowed" — a customer
                    with a closed or defaulted loan lands here too. The
                    default warning wins the slot when both apply. */}
                {!c.hasLoans && !c.hasDefaulted && (
                  <span className="text-primary">NO ACTIVE LOAN</span>
                )}
              </span>
            </span>
          )}
        />
      </Field>
      {form.customerId && <BorrowerContextBar customerId={form.customerId} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Step 2 — Product & Terms
// ═══════════════════════════════════════════════════════════════════

function Step2ProductTerms({
  form,
  setForm,
  products,
  product,
  quote,
  ltv,
  onKycReadinessChange,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  products: LoanProduct[];
  product: LoanProduct | undefined;
  quote: ReturnType<typeof useQuote>["data"];
  ltv: number | null;
  onKycReadinessChange: (ready: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <StepHeading
        title="Which product and what terms?"
        subtitle="The product determines required documents, collateral type, and the rate / term ranges. KYC and affordability feedback below update live."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Loan product">
          <Select
            value={form.productCode}
            onValueChange={(next) => {
              const p = products.find((x) => x.code === next);
              setForm((f) => ({
                ...f,
                productCode: next,
                ratePercent: p ? Number(p.defaultRate) * 100 : f.ratePercent,
              }));
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="— select a product —" />
            </SelectTrigger>
            <SelectContent>
              {products
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
          <div className="text-xs text-fg-muted self-center">
            Range: {formatMoney(Number(product.minPrincipal))}–
            {formatMoney(Number(product.maxPrincipal))} ·{" "}
            {product.minTermMonths}–{product.maxTermMonths} months ·{" "}
            {(Number(product.minRate) * 100).toFixed(1)}–
            {(Number(product.maxRate) * 100).toFixed(1)}% APR
            {product.maxLoanToValue != null && (
              <> · LTV ≤ {(Number(product.maxLoanToValue) * 100).toFixed(0)}%</>
            )}
          </div>
        )}
      </div>

      {form.customerId && form.productCode && (
        <KycGapWarning
          customerId={form.customerId}
          productRequiredDocs={product?.requiredKycDocs ?? []}
          onReadinessChange={onKycReadinessChange}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Principal (₱)">
          <Input
            type="number"
            min={product ? Number(product.minPrincipal) : 1}
            max={product ? Number(product.maxPrincipal) : undefined}
            value={form.principal}
            onChange={(e) =>
              setForm((f) => ({ ...f, principal: Number(e.target.value) }))
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
              setForm((f) => ({ ...f, termMonths: Number(e.target.value) }))
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
              setForm((f) => ({ ...f, ratePercent: Number(e.target.value) }))
            }
            required
          />
        </Field>
      </div>

      {form.customerId && form.productCode && (
        <AffordabilityGuardrails
          customerId={form.customerId}
          principal={form.principal}
          termMonths={form.termMonths}
          ratePercent={form.ratePercent}
        />
      )}

      {quote && (
        <div className="rounded-md border border-default bg-surface-2 p-3 text-sm space-y-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-wider text-fg-subtle">
            <span>Quote</span>
            <span>
              {quote.method === "FLAT" ? "Flat interest" : "Declining balance"}{" "}
              · {quote.frequency.toLowerCase()} · {quote.installments}{" "}
              installments
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat
              label="Per period"
              value={formatMoney(quote.monthlyPayment)}
            />
            <Stat label="Total paid" value={formatMoney(quote.totalPaid)} />
            <Stat label="Interest" value={formatMoney(quote.totalInterest)} />
            {ltv != null && (
              <Stat label="LTV" value={`${(ltv * 100).toFixed(1)}%`} />
            )}
          </div>
          {quote.fees.total > 0 && (
            <div className="border-t border-default pt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat
                label="Processing fee"
                value={formatMoney(quote.fees.processing)}
              />
              <Stat
                label="Doc stamp"
                value={formatMoney(quote.fees.documentary)}
              />
              <Stat label="Total fees" value={formatMoney(quote.fees.total)} />
              <Stat
                label="Net to customer"
                value={formatMoney(quote.fees.netDisbursement)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Step 3 — Collateral & Co-makers
// ═══════════════════════════════════════════════════════════════════

function Step3CollateralCoMakers({
  form,
  setForm,
  product,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  product: LoanProduct | undefined;
}) {
  const collateralKind = product?.collateralKind ?? "NONE";

  const addCoMaker = () => {
    setForm((f) => ({
      ...f,
      coMakers: [
        ...f.coMakers,
        {
          _key: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          fullName: "",
          phone: "",
          role: "CO_MAKER",
          relationship: "",
        },
      ],
    }));
  };
  const removeCoMaker = (key: string) =>
    setForm((f) => ({
      ...f,
      coMakers: f.coMakers.filter((cm) => cm._key !== key),
    }));
  const patchCoMaker = (key: string, patch: Partial<CoMakerDraft>) =>
    setForm((f) => ({
      ...f,
      coMakers: f.coMakers.map((cm) =>
        cm._key === key ? { ...cm, ...patch } : cm,
      ),
    }));

  return (
    <div className="space-y-4">
      <StepHeading
        title="Security: collateral & co-makers"
        subtitle="Collateral fields are required when the product is secured. Co-makers are optional but strengthen weaker applications."
      />

      {collateralKind === "NONE" && (
        <p className="rounded-md border border-default bg-surface-2 p-3 text-xs text-fg-muted">
          This product has no collateral requirement. Skip directly to co-makers
          below.
        </p>
      )}
      {collateralKind === "VEHICLE" && (
        <VehicleFieldset
          value={form.vehicle}
          onChange={(v) => setForm((f) => ({ ...f, vehicle: v }))}
          productCode={form.productCode}
        />
      )}
      {collateralKind === "PROPERTY" && (
        <PropertyFieldset
          value={form.property}
          onChange={(p) => setForm((f) => ({ ...f, property: p }))}
        />
      )}

      <fieldset className="rounded-md border border-default p-3 space-y-3">
        <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle flex items-center gap-1">
          <Users className="h-3 w-3" />
          Co-makers · {form.coMakers.length} added
        </legend>
        {form.coMakers.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No co-makers yet. Adding one improves approval odds for thin-file or
            borderline-DTI applicants.
          </p>
        ) : (
          <ul className="space-y-2">
            {form.coMakers.map((cm) => (
              <li
                key={cm._key}
                className="rounded border border-default bg-surface-2 p-2 space-y-2"
              >
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                  <Field label="Full name">
                    <Input
                      value={cm.fullName}
                      onChange={(e) =>
                        patchCoMaker(cm._key, { fullName: e.target.value })
                      }
                      required
                    />
                  </Field>
                  <Field label="Phone">
                    <Input
                      value={cm.phone}
                      onChange={(e) =>
                        patchCoMaker(cm._key, { phone: e.target.value })
                      }
                      required
                    />
                  </Field>
                  <Field label="Role">
                    <Select
                      value={cm.role ?? "CO_MAKER"}
                      onValueChange={(v) =>
                        patchCoMaker(cm._key, { role: v as CoMakerRole })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CO_MAKER">Co-maker</SelectItem>
                        <SelectItem value="CO_BORROWER">Co-borrower</SelectItem>
                        <SelectItem value="GUARANTOR">Guarantor</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Relationship">
                    <Input
                      value={cm.relationship ?? ""}
                      onChange={(e) =>
                        patchCoMaker(cm._key, { relationship: e.target.value })
                      }
                      placeholder="Spouse, parent, sibling…"
                    />
                  </Field>
                </div>
                <div className="flex items-center justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeCoMaker(cm._key)}
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" onClick={addCoMaker}>
          <Users className="h-3 w-3" />
          Add co-maker
        </Button>
      </fieldset>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Step 4 — Verification (selfie + purpose / notes)
// ═══════════════════════════════════════════════════════════════════

function Step4Verification({
  form,
  setForm,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  return (
    <div className="space-y-4">
      <StepHeading
        title="Verify the applicant"
        subtitle="Live selfie strengthens the fraud signal. Purpose helps the underwriter understand intent."
      />
      <fieldset className="rounded-md border border-default p-3 space-y-2">
        <legend className="px-1 text-xs uppercase tracking-wider text-fg-subtle flex items-center gap-1">
          <Camera className="h-3 w-3" />
          Application selfie
        </legend>
        <p className="text-xs text-fg-muted">
          Live capture of the borrower for face-match against the ID on file.
          Optional but strongly recommended.
        </p>
        <FileUpload
          subdir="selfies"
          value={form.applicationSelfieUrl}
          onUploaded={(url) =>
            setForm((f) => ({ ...f, applicationSelfieUrl: url }))
          }
          onClear={() => setForm((f) => ({ ...f, applicationSelfieUrl: null }))}
          accept="image/*"
          capture="user"
          label="Take/upload selfie"
        />
      </fieldset>
      <Field label="Purpose / notes">
        <Input
          value={form.purpose}
          onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
          placeholder="e.g. Working capital, second car, refinance"
        />
      </Field>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Step 5 — Review (read-only summary + pre-decisioning verdict)
// ═══════════════════════════════════════════════════════════════════

function Step5Review({
  form,
  product,
  quote,
  ltv,
}: {
  form: FormState;
  product: LoanProduct | undefined;
  quote: ReturnType<typeof useQuote>["data"];
  ltv: number | null;
}) {
  return (
    <div className="space-y-4">
      <StepHeading
        title="Review and submit"
        subtitle="Last chance to fix anything. The decisioning engine's verdict shows below so you know what to expect."
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <SummaryCard title="Loan terms">
          <Stat label="Product" value={product?.name ?? form.productCode} />
          <Stat label="Principal" value={formatMoney(form.principal)} />
          <Stat label="Term" value={`${form.termMonths} months`} />
          <Stat label="APR" value={`${form.ratePercent.toFixed(2)}%`} />
          {quote && (
            <>
              <Stat
                label="Per period"
                value={formatMoney(quote.monthlyPayment)}
              />
              <Stat
                label="Total interest"
                value={formatMoney(quote.totalInterest)}
              />
            </>
          )}
          {ltv != null && (
            <Stat label="LTV" value={`${(ltv * 100).toFixed(1)}%`} />
          )}
        </SummaryCard>
        <SummaryCard title="Collateral & co-makers">
          <Stat
            label="Collateral"
            value={
              product?.collateralKind === "VEHICLE"
                ? `${form.vehicle.make} ${form.vehicle.model} (${form.vehicle.year}) · ₱${formatMoney(form.vehicle.appraisedValue).replace(/^₱/, "")}`
                : product?.collateralKind === "PROPERTY"
                  ? `${form.property.propertyType} · ${form.property.address} · ₱${formatMoney(form.property.appraisedValue).replace(/^₱/, "")}`
                  : "None"
            }
          />
          <Stat
            label="Co-makers"
            value={
              form.coMakers.length === 0
                ? "None"
                : form.coMakers
                    .map((cm) => `${cm.fullName} (${cm.role ?? "CO_MAKER"})`)
                    .join(", ")
            }
          />
          <Stat
            label="Selfie"
            value={form.applicationSelfieUrl ? "Captured" : "Not provided"}
          />
          <Stat label="Purpose" value={form.purpose || "—"} />
        </SummaryCard>
      </div>
      <PreDecisionPreview
        customerId={form.customerId}
        productCode={form.productCode}
        principal={form.principal}
        termMonths={form.termMonths}
        ratePercent={form.ratePercent}
      />
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-default pb-3 mb-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-xs text-fg-muted mt-1">{subtitle}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-fg-muted">{label}</label>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-xs">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="font-mono text-fg truncate">{value}</div>
    </div>
  );
}

function SummaryCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-fg-subtle">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
