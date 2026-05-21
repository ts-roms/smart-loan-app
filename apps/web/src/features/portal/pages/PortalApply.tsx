import {
  useLoanProducts,
  usePortalApplyLoan,
  useQuote,
} from "@loan/api-client";
import type {
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
import { useNavigate } from "react-router-dom";

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
    if (product.collateralKind === "VEHICLE") {
      setVehicle((v) => ({
        ...v,
        kind: productCode === "MOTORCYCLE" ? "MOTORCYCLE" : "CAR",
      }));
    }
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
      });
      toast.success(
        "Application submitted! An officer will review it shortly.",
      );
      navigate(`/portal/loans/${created.number}`);
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
            <div className="text-xs text-white/55">
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
            <fieldset className="rounded-md border border-white/10 p-3 space-y-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-white/45">
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
            <fieldset className="rounded-md border border-white/10 p-3 space-y-3">
              <legend className="px-1 text-xs uppercase tracking-wider text-white/45">
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

          <div className="rounded-md border border-white/10 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-white/45 flex items-center gap-1">
              <Camera className="h-3 w-3" />
              Selfie verification
            </div>
            <p className="text-xs text-white/55">
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

          {quote.data && (
            <div className="rounded-md border border-white/10 bg-white/[0.04] p-3 text-sm">
              <div className="text-xs uppercase tracking-wider text-white/45 mb-1">
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
            disabled={!ready || apply.isPending}
            className="w-full"
          >
            {apply.isPending ? "Submitting…" : "Submit application"}
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
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
