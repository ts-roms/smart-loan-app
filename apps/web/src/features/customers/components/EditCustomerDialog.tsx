import { useUpdateCustomer } from "@loan/api-client";
import type { Customer, CustomerCreateInput } from "@loan/shared-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  useToast,
} from "@loan/ui";
import { Pencil } from "lucide-react";
import { useState } from "react";

import {
  CustomerProfileForm,
  customerToFormState,
} from "./CustomerProfileForm";

/**
 * Edit-existing-profile dialog. Uses the same sectioned form as the
 * create flow so the two paths can't drift apart. Hydrates the form
 * from the customer row, sends a PATCH on save.
 *
 * The PATCH endpoint accepts every field via `customerBaseSchema.partial()`,
 * so we just submit the full form state — the server only updates the
 * fields that changed (Prisma ignores undefined keys).
 */
export function EditCustomerDialog({
  customer,
  onClose,
}: {
  customer: Customer;
  onClose: () => void;
}) {
  const update = useUpdateCustomer();
  const toast = useToast();

  // Hydrate initial form state once. After that, the form owns it.
  const [form, setForm] = useState<CustomerCreateInput>(() =>
    customerToFormState(customer),
  );

  const submit = async () => {
    try {
      await update.mutateAsync({ id: customer.id, patch: form });
      toast.success("Customer profile updated.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Match the New customer dialog width — same form, same breathing room. */}
      {/* Same header-fixed / body-scrolls / footer-fixed shape as the
          new-customer dialog — both host CustomerProfileForm. */}
      <DialogContent className="flex max-h-[88vh] w-full max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-default px-6 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Edit customer profile
          </DialogTitle>
          <DialogDescription>
            Updating {customer.firstName} {customer.lastName} ·{" "}
            <span className="font-mono">{customer.number}</span>.
          </DialogDescription>
        </DialogHeader>
        <CustomerProfileForm
          form={form}
          setForm={setForm}
          onSubmit={submit}
          submitting={update.isPending}
          submitLabel="Save changes"
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
