import { useCreateCustomer, useCustomers } from "@loan/api-client";
import type { CustomerCreateInput, KycStatus } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { FileSpreadsheet, Plus, UserPlus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { CustomerProfileForm } from "../components/CustomerProfileForm";
import { CustomerSummaryLink } from "../components/CustomerSummaryDrawer";
import { IdOcrCard } from "../components/IdOcrCard";
import { findArticle, TourButton } from "../../help";

/**
 * Customer master list. Each row links to the customer detail page
 * where KYC docs, credit score history, and loans live. KYC status is
 * surfaced inline so officers can triage at a glance.
 */
export function CustomersPage() {
  const customers = useCustomers();
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Customers</CardTitle>
        <div className="flex items-center gap-2">
          <TourButton
            tourId="customers"
            steps={findArticle("customers")?.tour ?? []}
          />
          <Link
            to="/customers/bulk"
            className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-3 px-3 py-1.5 text-sm hover:bg-hover"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Bulk import
          </Link>
          <Button onClick={() => setAdding(true)} data-tour="customers-new">
            <Plus className="h-4 w-4" />
            New customer
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {customers.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
          </div>
        ) : (customers.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">
            No customers yet. Add one to get started.
          </p>
        ) : (
          <table className="w-full text-sm" data-tour="customers-table">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Reference</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Phone</th>
                <th className="py-2 px-2">Income</th>
                <th className="py-2 px-2">KYC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(customers.data ?? []).map((c) => (
                <tr key={c.id} className="hover:bg-hover">
                  {/* Human reference — shown as the leftmost column so it's
                      the primary handle for an operator scanning the list. */}
                  <td className="py-2 px-2 font-mono text-xs text-fg-muted">
                    {c.number}
                  </td>
                  <td className="py-2 px-2">
                    <CustomerSummaryLink customerId={c.number}>
                      <span className="text-info hover:underline">
                        {c.firstName} {c.lastName}
                      </span>
                    </CustomerSummaryLink>
                  </td>
                  <td className="py-2 px-2 font-mono text-xs">{c.phone}</td>
                  <td className="py-2 px-2">
                    {formatMoney(Number(c.monthlyIncome))}/mo
                  </td>
                  <td className="py-2 px-2">
                    <KycBadge status={c.kycStatus} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {adding && <NewCustomerDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}

function KycBadge({ status }: { status: KycStatus }) {
  const map: Record<
    KycStatus,
    { variant: "muted" | "warning" | "success" | "danger"; label: string }
  > = {
    NONE: { variant: "muted", label: "None" },
    PENDING: { variant: "warning", label: "Pending" },
    VERIFIED: { variant: "success", label: "Verified" },
    REJECTED: { variant: "danger", label: "Rejected" },
  };
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Create-customer dialog — thin wrapper around the shared
 * `CustomerProfileForm`. The form owns its sectioned layout, conditional
 * spouse/employer blocks, and PSGC region/province picker; this
 * component just wires up the create mutation + ID OCR helper.
 */
function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCustomer();
  const toast = useToast();

  const [form, setForm] = useState<CustomerCreateInput>({
    firstName: "",
    lastName: "",
    dateOfBirth: "",
    phone: "",
    address: "",
    city: "",
    governmentIdType: "NATIONAL_ID",
    governmentIdNumber: "",
    employmentStatus: "EMPLOYED",
    monthlyIncome: 0,
  });

  // OCR application — map best-guess extracted fields onto the form
  // state. Only overwrite empty values so the officer's own edits win.
  const applyOcr = (fx: import("../../../lib/id-ocr").ExtractedIdFields) => {
    setForm((f) => {
      const next = { ...f };
      if (!next.firstName && fx.firstName) next.firstName = fx.firstName;
      if (!next.lastName && fx.lastName) next.lastName = fx.lastName;
      // PH IDs put surname first on some layouts (UMID/Driver's License)
      // and last on others (Passport) — best-guess split when both are
      // still blank, then the officer corrects by hand.
      if (!next.firstName && !next.lastName && fx.fullName) {
        const parts = fx.fullName.trim().split(/\s+/);
        if (parts.length >= 2) {
          next.lastName = parts[0]!;
          next.firstName = parts.slice(1).join(" ");
        } else {
          next.firstName = fx.fullName;
        }
      }
      if (!next.dateOfBirth && fx.dateOfBirth)
        next.dateOfBirth = fx.dateOfBirth;
      if (!next.governmentIdNumber && fx.idNumber)
        next.governmentIdNumber = fx.idNumber;
      if (!next.address && fx.address) next.address = fx.address;
      return next;
    });
    toast.success("Applied. Review fields below before saving.");
  };

  const submit = async () => {
    try {
      await create.mutateAsync(form);
      toast.success("Customer added. Submit KYC documents next.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* max-w-5xl so the 2-column sectioned form has breathing room. The
          previous 3xl crammed Identity / Contact / Address fields into a
          narrow strip and forced extra scrolling on a desktop browser. */}
      <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New customer
          </DialogTitle>
          <DialogDescription>
            Capture personal, contact, address, civil, and employment details.
            KYC documents are uploaded separately after the profile is created.
          </DialogDescription>
        </DialogHeader>
        <CustomerProfileForm
          form={form}
          setForm={setForm}
          onSubmit={submit}
          submitting={create.isPending}
          submitLabel="Create customer"
          onCancel={onClose}
          topSlot={<IdOcrCard onApply={applyOcr} />}
          bottomSlot={
            <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-fg">
              <strong>Next step:</strong> after saving, upload the required ID +
              supporting documents from the customer detail page. KYC
              verification is required before the customer can apply for a loan.
            </div>
          }
        />
      </DialogContent>
    </Dialog>
  );
}
