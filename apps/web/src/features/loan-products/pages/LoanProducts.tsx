import {
  useCreateLoanProduct,
  useDeleteLoanProduct,
  useLoanProducts,
  useSeedLoanProducts,
  useUpdateLoanProduct,
} from "@loan/api-client";
import type {
  CollateralKind,
  CreditTier,
  InterestMethod,
  KycDocumentType,
  KycQuestion,
  LoanProduct,
  PaymentFrequency,
} from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { ListChecks, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";

import { ApprovalChainDialog } from "../components/ApprovalChainDialog";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { usePermission } from "../../../hooks/use-permission";

const TIERS: CreditTier[] = ["A", "B", "C", "D", "F"];

const DOC_OPTIONS: KycDocumentType[] = [
  "VEHICLE_OR",
  "VEHICLE_CR",
  "PROPERTY_TITLE",
  "TAX_DECLARATION",
  "SELFIE",
  "ID_BACK",
];

interface ProductDraft {
  code: string;
  name: string;
  description: string;
  collateralKind: CollateralKind;
  requiredKycDocs: KycDocumentType[];
  kycQuestions: KycQuestion[];
  minPrincipal: number;
  maxPrincipal: number;
  minTermMonths: number;
  maxTermMonths: number;
  defaultRatePct: number;
  minRatePct: number;
  maxRatePct: number;
  maxLtvPct: string;
  processingFeeRatePct: number;
  processingFeeFlat: number;
  documentaryStampRatePct: number;
  lateFeeDailyRatePct: number;
  lateFeeCapFractionPct: number;
  lateFeeGraceDays: number;
  preTerminationFeeRatePct: number;
  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;
  rateByTier: Partial<Record<CreditTier, string>>;
  ltvByTier: Partial<Record<CreditTier, string>>;
  useRateByTier: boolean;
  useLtvByTier: boolean;
  active: boolean;
}

const emptyDraft = (): ProductDraft => ({
  code: "",
  name: "",
  description: "",
  collateralKind: "NONE",
  requiredKycDocs: [],
  kycQuestions: [],
  minPrincipal: 5_000,
  maxPrincipal: 500_000,
  minTermMonths: 3,
  maxTermMonths: 36,
  defaultRatePct: 24,
  minRatePct: 12,
  maxRatePct: 36,
  maxLtvPct: "",
  processingFeeRatePct: 2,
  processingFeeFlat: 0,
  documentaryStampRatePct: 0.75,
  lateFeeDailyRatePct: 1,
  lateFeeCapFractionPct: 10,
  lateFeeGraceDays: 3,
  preTerminationFeeRatePct: 2,
  interestMethod: "DECLINING",
  paymentFrequency: "MONTHLY",
  rateByTier: {},
  ltvByTier: {},
  useRateByTier: false,
  useLtvByTier: false,
  active: true,
});

const fromProduct = (p: LoanProduct): ProductDraft => ({
  code: p.code,
  name: p.name,
  description: p.description ?? "",
  collateralKind: p.collateralKind,
  requiredKycDocs: [...p.requiredKycDocs],
  kycQuestions: [...(p.kycQuestions ?? [])],
  minPrincipal: Number(p.minPrincipal),
  maxPrincipal: Number(p.maxPrincipal),
  minTermMonths: p.minTermMonths,
  maxTermMonths: p.maxTermMonths,
  defaultRatePct: Number(p.defaultRate) * 100,
  minRatePct: Number(p.minRate) * 100,
  maxRatePct: Number(p.maxRate) * 100,
  maxLtvPct:
    p.maxLoanToValue == null ? "" : String(Number(p.maxLoanToValue) * 100),
  processingFeeRatePct: Number(p.processingFeeRate) * 100,
  processingFeeFlat: Number(p.processingFeeFlat),
  documentaryStampRatePct: Number(p.documentaryStampRate) * 100,
  lateFeeDailyRatePct: Number(p.lateFeeDailyRate) * 100,
  lateFeeCapFractionPct: Number(p.lateFeeCapFraction) * 100,
  lateFeeGraceDays: p.lateFeeGraceDays,
  preTerminationFeeRatePct: Number(p.preTerminationFeeRate) * 100,
  interestMethod: p.interestMethod,
  paymentFrequency: p.paymentFrequency,
  rateByTier: Object.fromEntries(
    Object.entries(p.rateByTier ?? {}).map(([k, v]) => [
      k,
      v == null ? "" : String(Number(v) * 100),
    ]),
  ),
  ltvByTier: Object.fromEntries(
    Object.entries(p.ltvByTier ?? {}).map(([k, v]) => [
      k,
      v == null ? "" : String(Number(v) * 100),
    ]),
  ),
  useRateByTier: !!p.rateByTier && Object.keys(p.rateByTier).length > 0,
  useLtvByTier: !!p.ltvByTier && Object.keys(p.ltvByTier).length > 0,
  active: p.active,
});

const draftToPayload = (d: ProductDraft, includeCode: boolean) => {
  const base = {
    name: d.name,
    description: d.description || undefined,
    collateralKind: d.collateralKind,
    requiredKycDocs: d.requiredKycDocs,
    kycQuestions: d.kycQuestions,
    minPrincipal: d.minPrincipal,
    maxPrincipal: d.maxPrincipal,
    minTermMonths: d.minTermMonths,
    maxTermMonths: d.maxTermMonths,
    defaultRate: d.defaultRatePct / 100,
    minRate: d.minRatePct / 100,
    maxRate: d.maxRatePct / 100,
    maxLoanToValue: d.maxLtvPct === "" ? null : Number(d.maxLtvPct) / 100,
    processingFeeRate: d.processingFeeRatePct / 100,
    processingFeeFlat: d.processingFeeFlat,
    documentaryStampRate: d.documentaryStampRatePct / 100,
    lateFeeDailyRate: d.lateFeeDailyRatePct / 100,
    lateFeeCapFraction: d.lateFeeCapFractionPct / 100,
    lateFeeGraceDays: d.lateFeeGraceDays,
    preTerminationFeeRate: d.preTerminationFeeRatePct / 100,
    interestMethod: d.interestMethod,
    paymentFrequency: d.paymentFrequency,
    rateByTier: d.useRateByTier
      ? (Object.fromEntries(
          TIERS.map((t) => [
            t,
            d.rateByTier[t] === "" ? null : Number(d.rateByTier[t]) / 100,
          ]),
        ) as Partial<Record<CreditTier, number | null>>)
      : null,
    ltvByTier: d.useLtvByTier
      ? (Object.fromEntries(
          TIERS.filter((t) => d.ltvByTier[t]).map((t) => [
            t,
            Number(d.ltvByTier[t]) / 100,
          ]),
        ) as Partial<Record<CreditTier, number>>)
      : null,
    active: d.active,
  };
  return includeCode ? { code: d.code, ...base } : base;
};

/**
 * Admin-only product catalog. Supports full create / edit / delete for an
 * unlimited number of products. The editor exposes all the configurable
 * dimensions: limits, fees, late-fee policy, interest method, payment
 * frequency, tiered rates, tiered LTV, pre-termination fee.
 */
export function LoanProductsPage() {
  const products = useLoanProducts();
  const seed = useSeedLoanProducts();
  const remove = useDeleteLoanProduct();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = usePermission("products.write");

  const [editing, setEditing] = useState<LoanProduct | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingChain, setEditingChain] = useState<LoanProduct | null>(null);

  const onDelete = async (p: LoanProduct) => {
    const ok = await confirm({
      title: `Delete product ${p.code}?`,
      message:
        "New applications can no longer use this product. The deletion will be blocked if any existing loans still reference it.",
      confirmLabel: "Delete product",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(p.code);
      toast.success(`Deleted ${p.code}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Cannot delete");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Loan products</CardTitle>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await seed.mutateAsync();
                  toast.success(
                    `Seeded ${r.created} products (${r.existing} already present)`,
                  );
                } catch (err) {
                  toast.error((err as Error).message ?? "Could not seed");
                }
              }}
              disabled={seed.isPending}
            >
              <Sparkles className="h-4 w-4" />
              Seed defaults
            </Button>
          )}
          {canEdit && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New product
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {products.isLoading ? (
          <SkeletonCard />
        ) : (products.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">
            No products yet. Click "Seed defaults" or "New product" to get
            started.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Code</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Collateral</th>
                <th className="py-2 px-2 text-right">Principal</th>
                <th className="py-2 px-2 text-right">Term</th>
                <th className="py-2 px-2 text-right">Rate</th>
                <th className="py-2 px-2">Method</th>
                <th className="py-2 px-2">Frequency</th>
                <th className="py-2 px-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(products.data ?? []).map((p) => (
                <tr key={p.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">{p.code}</td>
                  <td className="py-2 px-2">
                    <div>{p.name}</div>
                    {p.description && (
                      <div className="text-xs text-fg-subtle">
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-fg-muted">
                    {p.collateralKind}
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-xs">
                    {formatMoney(Number(p.minPrincipal))}–
                    {formatMoney(Number(p.maxPrincipal))}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {p.minTermMonths}–{p.maxTermMonths}m
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {(Number(p.minRate) * 100).toFixed(1)}–
                    {(Number(p.maxRate) * 100).toFixed(1)}%
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <Badge variant="muted">{p.interestMethod}</Badge>
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <Badge variant="muted">{p.paymentFrequency}</Badge>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={p.active ? "success" : "muted"}>
                      {p.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingChain(p)}
                          className="text-fg-muted hover:text-info"
                          title="Approval chain"
                        >
                          <ListChecks className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(p)}
                          className="text-fg-muted hover:text-info"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(p)}
                          className="text-fg-muted hover:text-danger"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {creating && <CreateProductDialog onClose={() => setCreating(false)} />}
      {editing && (
        <EditProductDialog product={editing} onClose={() => setEditing(null)} />
      )}
      {editingChain && (
        <ApprovalChainDialog
          productCode={editingChain.code}
          productName={editingChain.name}
          onClose={() => setEditingChain(null)}
        />
      )}
    </Card>
  );
}

function CreateProductDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateLoanProduct();
  const toast = useToast();
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft());

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync(draftToPayload(draft, true) as never);
      toast.success(`Product ${draft.code} created`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New loan product</DialogTitle>
        </DialogHeader>
        <ProductForm
          draft={draft}
          setDraft={setDraft}
          onSubmit={onSubmit}
          includeCode
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={create.isPending}>
            Create product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProductDialog({
  product,
  onClose,
}: {
  product: LoanProduct;
  onClose: () => void;
}) {
  const update = useUpdateLoanProduct();
  const toast = useToast();
  const [draft, setDraft] = useState<ProductDraft>(() => fromProduct(product));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const payload = draftToPayload(draft, false) as Record<string, unknown>;
      await update.mutateAsync({ code: product.code, ...payload });
      toast.success("Product saved");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {product.name}</DialogTitle>
        </DialogHeader>
        <ProductForm
          draft={draft}
          setDraft={setDraft}
          onSubmit={onSubmit}
          includeCode={false}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} loading={update.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductForm({
  draft,
  setDraft,
  onSubmit,
  includeCode,
}: {
  draft: ProductDraft;
  setDraft: (d: ProductDraft) => void;
  onSubmit: (e: FormEvent) => void;
  includeCode: boolean;
}) {
  const set = <K extends keyof ProductDraft>(key: K, val: ProductDraft[K]) =>
    setDraft({ ...draft, [key]: val });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Basics */}
      <Section title="Basics">
        <div className="grid grid-cols-2 gap-3">
          {includeCode && (
            <Field label="Code (UPPER_SNAKE)">
              <Input
                value={draft.code}
                onChange={(e) =>
                  set(
                    "code",
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                  )
                }
                placeholder="EDUCATIONAL"
                required
              />
            </Field>
          )}
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </Field>
          <Field label="Description">
            <Input
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <Field label="Collateral kind">
            <Select
              value={draft.collateralKind}
              onValueChange={(v) => set("collateralKind", v as CollateralKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">None</SelectItem>
                <SelectItem value="VEHICLE">Vehicle</SelectItem>
                <SelectItem value="PROPERTY">Property</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={draft.active ? "active" : "inactive"}
              onValueChange={(v) => set("active", v === "active")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>

      {/* Limits */}
      <Section title="Limits">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min principal (₱)">
            <Input
              type="number"
              min={0}
              value={draft.minPrincipal}
              onChange={(e) => set("minPrincipal", Number(e.target.value))}
            />
          </Field>
          <Field label="Max principal (₱)">
            <Input
              type="number"
              min={0}
              value={draft.maxPrincipal}
              onChange={(e) => set("maxPrincipal", Number(e.target.value))}
            />
          </Field>
          <Field label="Min term (months)">
            <Input
              type="number"
              min={1}
              value={draft.minTermMonths}
              onChange={(e) => set("minTermMonths", Number(e.target.value))}
            />
          </Field>
          <Field label="Max term (months)">
            <Input
              type="number"
              min={1}
              value={draft.maxTermMonths}
              onChange={(e) => set("maxTermMonths", Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-2">
          <Field label="Default rate (%)">
            <Input
              type="number"
              min={0}
              step={0.25}
              value={draft.defaultRatePct}
              onChange={(e) => set("defaultRatePct", Number(e.target.value))}
            />
          </Field>
          <Field label="Min rate (%)">
            <Input
              type="number"
              min={0}
              step={0.25}
              value={draft.minRatePct}
              onChange={(e) => set("minRatePct", Number(e.target.value))}
            />
          </Field>
          <Field label="Max rate (%)">
            <Input
              type="number"
              min={0}
              step={0.25}
              value={draft.maxRatePct}
              onChange={(e) => set("maxRatePct", Number(e.target.value))}
            />
          </Field>
        </div>
        {draft.collateralKind !== "NONE" && (
          <Field label="Max LTV (%, blank = no cap)">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={draft.maxLtvPct}
              onChange={(e) => set("maxLtvPct", e.target.value)}
            />
          </Field>
        )}
      </Section>

      {/* Fees */}
      <Section title="Fees">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Processing fee (% of principal)">
            <Input
              type="number"
              min={0}
              step={0.05}
              value={draft.processingFeeRatePct}
              onChange={(e) =>
                set("processingFeeRatePct", Number(e.target.value))
              }
            />
          </Field>
          <Field label="Processing fee (flat ₱)">
            <Input
              type="number"
              min={0}
              value={draft.processingFeeFlat}
              onChange={(e) => set("processingFeeFlat", Number(e.target.value))}
            />
          </Field>
          <Field label="Documentary stamp (%)">
            <Input
              type="number"
              min={0}
              step={0.01}
              value={draft.documentaryStampRatePct}
              onChange={(e) =>
                set("documentaryStampRatePct", Number(e.target.value))
              }
            />
          </Field>
          <Field label="Pre-termination fee (% of remaining)">
            <Input
              type="number"
              min={0}
              step={0.25}
              value={draft.preTerminationFeeRatePct}
              onChange={(e) =>
                set("preTerminationFeeRatePct", Number(e.target.value))
              }
            />
          </Field>
        </div>
      </Section>

      {/* Late-fee policy */}
      <Section title="Late-fee policy">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Daily rate (% of installment)">
            <Input
              type="number"
              min={0}
              step={0.05}
              value={draft.lateFeeDailyRatePct}
              onChange={(e) =>
                set("lateFeeDailyRatePct", Number(e.target.value))
              }
            />
          </Field>
          <Field label="Cap (% of installment)">
            <Input
              type="number"
              min={0}
              max={100}
              step={0.5}
              value={draft.lateFeeCapFractionPct}
              onChange={(e) =>
                set("lateFeeCapFractionPct", Number(e.target.value))
              }
            />
          </Field>
          <Field label="Grace days">
            <Input
              type="number"
              min={0}
              value={draft.lateFeeGraceDays}
              onChange={(e) => set("lateFeeGraceDays", Number(e.target.value))}
            />
          </Field>
        </div>
      </Section>

      {/* Interest method + frequency */}
      <Section title="Repayment schedule">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Interest method">
            <Select
              value={draft.interestMethod}
              onValueChange={(v) => set("interestMethod", v as InterestMethod)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DECLINING">Declining balance</SelectItem>
                <SelectItem value="FLAT">Flat (add-on)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Payment frequency">
            <Select
              value={draft.paymentFrequency}
              onValueChange={(v) =>
                set("paymentFrequency", v as PaymentFrequency)
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MONTHLY">Monthly</SelectItem>
                <SelectItem value="BIWEEKLY">Bi-weekly</SelectItem>
                <SelectItem value="WEEKLY">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </Section>

      {/* Tiered rates */}
      <Section title="Tiered pricing">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.useRateByTier}
            onChange={(e) => set("useRateByTier", e.target.checked)}
          />
          Use tier-based rates (overrides applicant-entered rate)
        </label>
        {draft.useRateByTier && (
          <div className="grid grid-cols-5 gap-2 mt-2">
            {TIERS.map((t) => (
              <Field key={t} label={`Tier ${t} rate (%) — blank = reject`}>
                <Input
                  type="number"
                  min={0}
                  step={0.25}
                  value={draft.rateByTier[t] ?? ""}
                  onChange={(e) =>
                    set("rateByTier", {
                      ...draft.rateByTier,
                      [t]: e.target.value,
                    })
                  }
                />
              </Field>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm mt-3">
          <input
            type="checkbox"
            checked={draft.useLtvByTier}
            onChange={(e) => set("useLtvByTier", e.target.checked)}
          />
          Use tier-based LTV caps (overrides max LTV above)
        </label>
        {draft.useLtvByTier && draft.collateralKind !== "NONE" && (
          <div className="grid grid-cols-5 gap-2 mt-2">
            {TIERS.map((t) => (
              <Field key={t} label={`Tier ${t} max LTV (%)`}>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.ltvByTier[t] ?? ""}
                  onChange={(e) =>
                    set("ltvByTier", {
                      ...draft.ltvByTier,
                      [t]: e.target.value,
                    })
                  }
                />
              </Field>
            ))}
          </div>
        )}
      </Section>

      {/* Required KYC */}
      <Section title="Required KYC documents (additional)">
        <div className="grid grid-cols-3 gap-2">
          {DOC_OPTIONS.map((d) => (
            <label key={d} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.requiredKycDocs.includes(d)}
                onChange={(e) =>
                  set(
                    "requiredKycDocs",
                    e.target.checked
                      ? [...draft.requiredKycDocs, d]
                      : draft.requiredKycDocs.filter((x) => x !== d),
                  )
                }
              />
              {d}
            </label>
          ))}
        </div>
        <p className="text-xs text-fg-subtle">
          Base docs (ID_FRONT, PROOF_OF_INCOME, PROOF_OF_ADDRESS) are always
          required.
        </p>
      </Section>

      {/* The questionnaire itself lives in Questionnaires, next to the
          credit survey — one place for everything the app asks an
          applicant. `kycQuestions` still rides along in the draft so
          saving a product here can't wipe what was configured there. */}
      <Section title="KYC declaration questionnaire">
        <p className="text-sm text-fg-muted">
          {draft.kycQuestions.length === 0
            ? "No declaration questions yet."
            : `${draft.kycQuestions.length} question(s) configured.`}{" "}
          <Link
            to="/questionnaires"
            className="text-brand hover:underline underline-offset-4"
          >
            Edit them in Questionnaires
          </Link>
          .
        </p>
      </Section>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-default p-3 space-y-3">
      <div className="text-xs uppercase tracking-wider text-fg-subtle">
        {title}
      </div>
      {children}
    </div>
  );
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
