import {
  useLoanProducts,
  useRenewLoan,
  type RenewalEligibility,
} from "@loan/api-client";
import { formatMoney } from "@loan/shared-utils";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@loan/ui";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Renew a loan: a new one whose proceeds settle the old.
 *
 * The whole point of the dialog is the arithmetic at the bottom. A
 * borrower asking to renew wants one number — what actually reaches
 * them — and it is not the principal they are quoted. Showing the
 * payoff and the net side by side, live as they type, is the
 * difference between an informed request and a surprise on
 * disbursement day.
 */
export function RenewLoanDialog({
  loanNumber,
  eligibility,
  defaultProductCode,
  onClose,
}: {
  loanNumber: string;
  /** Already known to be eligible — the caller gates on it. */
  eligibility: RenewalEligibility;
  defaultProductCode: string;
  onClose: () => void;
}) {
  const products = useLoanProducts();
  const renew = useRenewLoan();
  const toast = useToast();
  const navigate = useNavigate();

  const [productCode, setProductCode] = useState(defaultProductCode);
  const [principal, setPrincipal] = useState(0);
  const [termMonths, setTermMonths] = useState(12);
  const [ratePct, setRatePct] = useState(18);

  const payoff = eligibility.payoffAmount ?? 0;
  const net = principal - payoff;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await renew.mutateAsync({
        loanIdOrNumber: loanNumber,
        productCode,
        principal,
        termMonths,
        // The API takes a fraction; the field asks for a percentage,
        // because nobody quotes a borrower "0.18".
        annualInterestRate: ratePct / 100,
      });
      toast.success(
        `Renewal ${res.loan.number} created — ${formatMoney(res.netProceeds)} to release after settling ${formatMoney(res.payoffAmount)}.`,
      );
      onClose();
      void navigate(`/loans/${res.loan.number}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create the renewal");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Renew {loanNumber}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="rn-product">Product</Label>
              <Select value={productCode} onValueChange={setProductCode}>
                <SelectTrigger id="rn-product">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(products.data ?? []).map((p) => (
                    <SelectItem key={p.code} value={p.code}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rn-principal">New principal</Label>
              <Input
                id="rn-principal"
                type="number"
                min={1}
                value={principal || ""}
                onChange={(e) => setPrincipal(Number(e.target.value))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rn-term">Term (months)</Label>
              <Input
                id="rn-term"
                type="number"
                min={1}
                value={termMonths}
                onChange={(e) => setTermMonths(Number(e.target.value))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rn-rate">Annual rate (%)</Label>
              <Input
                id="rn-rate"
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={ratePct}
                onChange={(e) => setRatePct(Number(e.target.value))}
                required
              />
            </div>
          </div>

          {/* The arithmetic, live. */}
          <div className="rounded-md border border-default bg-surface-1 p-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-fg-muted">New principal</span>
              <span className="tabular">{formatMoney(principal)}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-fg-muted">
                Less: settlement of {loanNumber}
              </span>
              <span className="tabular text-warning">
                −{formatMoney(payoff)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t border-default pt-2 font-semibold">
              <span>Released to borrower</span>
              <span
                className={
                  net < 0 ? "tabular text-danger" : "tabular text-success"
                }
              >
                {formatMoney(net)}
              </span>
            </div>
            {net < 0 && (
              /*
                Not blocked, but named. A principal below the payoff is
                a legitimate arrangement — the borrower tops up the
                difference in cash — and it is also exactly what a
                mistyped figure looks like. Refusing outright would
                obstruct the first; staying silent would ship the
                second.
              */
              <p className="mt-2 text-[11px] text-danger">
                The new loan is smaller than the outstanding balance. The
                borrower would need to pay {formatMoney(Math.abs(net))} to
                complete this renewal.
              </p>
            )}
          </div>

          <p className="text-[11px] text-fg-subtle">
            Nothing is settled yet. {loanNumber} stays open and unchanged until
            this renewal is approved and disbursed.
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={renew.isPending}
              disabled={principal <= 0}
            >
              Create renewal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
