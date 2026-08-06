import { useAddCoMaker, useCustomers } from "@loan/api-client";
import type { CoMakerRole } from "@loan/shared-types";
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
import { useMemo, useState, type FormEvent } from "react";

/**
 * Add a co-maker to an existing loan.
 *
 * The new-loan wizard could always do this; the detail page couldn't,
 * so a loan that turned out to need a guarantor after submission had to
 * be abandoned and re-applied. That is a real cost — the application
 * keeps its number, its KYC and its place in the approval queue.
 *
 * A co-maker is a registered customer, never a typed name: they are
 * jointly liable, so they get underwritten like a borrower, and none of
 * that is possible for free text. The picker filters out the borrower
 * and anyone already on the loan — the API refuses both, but refusing
 * something you offered is worse than not offering it.
 */
export function AddCoMakerDialog({
  loanId,
  borrowerId,
  existingCustomerIds,
  onClose,
}: {
  loanId: string;
  /** Excluded from the pool — nobody guarantees their own debt. */
  borrowerId: string;
  /** Already co-makers on this loan; one person, one guarantee. */
  existingCustomerIds: string[];
  onClose: () => void;
}) {
  const customers = useCustomers();
  const add = useAddCoMaker();
  const toast = useToast();

  const [customerId, setCustomerId] = useState("");
  const [role, setRole] = useState<CoMakerRole>("CO_MAKER");
  const [relationship, setRelationship] = useState("");

  const eligible = useMemo(() => {
    const taken = new Set([borrowerId, ...existingCustomerIds]);
    return (customers.data ?? []).filter((c) => !taken.has(c.id));
  }, [customers.data, borrowerId, existingCustomerIds]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!customerId) return;
    try {
      await add.mutateAsync({
        loanId,
        customerId,
        role,
        relationship: relationship.trim() || undefined,
      });
      toast.success("Co-maker added — send them a consent link next.");
      onClose();
    } catch (err) {
      // The API's message is specific (already on the loan, is the
      // borrower, no such customer) and worth surfacing verbatim.
      toast.error((err as Error).message ?? "Could not add the co-maker");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add co-maker</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cm-customer">Registered customer</Label>
            <Select
              value={customerId || undefined}
              onValueChange={setCustomerId}
            >
              <SelectTrigger id="cm-customer">
                <SelectValue placeholder="Choose a customer…" />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.firstName} {c.lastName} · {c.number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {customers.data && eligible.length === 0 && (
              <p className="text-[11px] text-warning">
                No eligible customers — everyone on file is already the borrower
                or a co-maker on this loan.
              </p>
            )}
            <p className="text-[11px] text-fg-subtle">
              Their name, number and ID come from that record. A co-maker is
              jointly liable, so they have to be someone already on file.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cm-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as CoMakerRole)}
            >
              <SelectTrigger id="cm-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CO_MAKER">Co-maker</SelectItem>
                <SelectItem value="CO_BORROWER">Co-borrower</SelectItem>
                <SelectItem value="GUARANTOR">Guarantor</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cm-rel">Relationship to borrower</Label>
            <Input
              id="cm-rel"
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="Spouse, parent, sibling…"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={add.isPending}
              disabled={!customerId}
            >
              Add co-maker
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
