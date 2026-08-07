import { useCreateCustomer, useCustomersPage } from "@loan/api-client";
import type {
  CustomerCreateInput,
  CustomerListQuery,
  KycStatus,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { FileSpreadsheet, Plus, Search, UserPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { usePermission } from "../../../hooks/use-permission";
import { useDebouncedValue } from "../../../lib/use-debounced-value";
import { CustomerProfileForm } from "../components/CustomerProfileForm";
import { CustomerSummaryLink } from "../components/CustomerSummaryDrawer";
import { IdOcrCard } from "../components/IdOcrCard";
import { findArticle, TourButton } from "../../help";

/**
 * Customer master list. Each row links to the customer detail page
 * where KYC docs, credit score history, and loans live. KYC status is
 * surfaced inline so officers can triage at a glance.
 *
 * Search and filtering are server-side. The list is capped at 200 rows,
 * so filtering what was already fetched would search the newest page and
 * miss the long-standing customer the officer is looking for — the exact
 * case where search matters most.
 */
/** Rows per page in the table. The endpoint's own default is 200. */
const PAGE_SIZE = 25;

export function CustomersPage() {
  /*
   * `customers.read` gets you this list; creating one needs
   * `customers.write`, which ACCOUNTANT and COLLECTOR do not hold. Both
   * controls were rendered unconditionally, so those roles saw "New
   * customer" and "Bulk import" and got a 403 on click — the server was
   * never at risk, but the screen was promising something it could not
   * deliver.
   */
  const canWrite = usePermission("customers.write");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [kycStatus, setKycStatus] = useState<KycStatus | "ALL">("ALL");
  const [page, setPage] = useState(1);

  // Only the debounced copy reaches the query key, so a typed name costs
  // one request rather than one per keystroke.
  const q = useDebouncedValue(search.trim()) || undefined;
  const filter: CustomerListQuery = {
    q,
    kycStatus: kycStatus === "ALL" ? undefined : kycStatus,
    page,
    pageSize: PAGE_SIZE,
  };
  const filtered = Boolean(filter.q || filter.kycStatus);

  // Narrowing the filter reshuffles the result set, so the page the
  // operator was on no longer means anything — page 4 of a two-page
  // result is an empty table that reads as "no matches".
  useEffect(() => {
    setPage(1);
  }, [q, kycStatus]);

  const customers = useCustomersPage(filter);
  const rows = customers.data?.rows ?? [];
  const total = customers.data?.total ?? 0;

  const clearFilters = () => {
    setSearch("");
    setKycStatus("ALL");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Customers</CardTitle>
        <div className="flex items-center gap-2">
          <TourButton
            tourId="customers"
            steps={findArticle("customers")?.tour ?? []}
          />
          {canWrite && (
            <>
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
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle" />
            <Input
              className="pl-8"
              placeholder="Search name, reference, phone or ID…"
              aria-label="Search customers"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            value={kycStatus}
            onValueChange={(v) => setKycStatus(v as KycStatus | "ALL")}
          >
            <SelectTrigger className="w-44" aria-label="Filter by KYC status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All KYC statuses</SelectItem>
              <SelectItem value="NONE">No documents</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="VERIFIED">Verified</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
          {filtered && (
            <Button variant="ghost" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          {/* Match count, not row count — the table shows one page. The
              range readout lives with the page control at the bottom. */}
          <span className="text-xs text-fg-muted ml-auto">
            {total} customer{total === 1 ? "" : "s"}
          </span>
        </div>

        {customers.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
          </div>
        ) : rows.length === 0 ? (
          // An empty book and an empty result set need different nudges:
          // one is "create something", the other is "loosen the filter".
          <p className="text-sm text-fg-muted">
            {filtered
              ? "No customers match those filters."
              : canWrite
                ? "No customers yet. Add one to get started."
                : /* Don't tell a reader to do something they can't. */
                  "No customers yet."}
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
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-hover">
                  {/* Human reference — shown as the leftmost column so it's
                      the primary handle for an operator scanning the list.
                      Links straight to the profile; the name next to it
                      opens the quick-summary drawer instead, so both the
                      fast path and the full page are one click away. */}
                  <td className="py-2 px-2 font-mono text-xs">
                    <Link
                      to={`/customers/${c.number}`}
                      className="text-fg-muted hover:text-info hover:underline"
                    >
                      {c.number}
                    </Link>
                  </td>
                  <td className="py-2 px-2">
                    <CustomerSummaryLink customerId={c.number}>
                      <span className="text-info hover:underline">
                        {c.firstName} {c.lastName}
                      </span>
                    </CustomerSummaryLink>
                    {c.erasedAt && (
                      <Badge variant="danger" className="ml-2">
                        Erased
                      </Badge>
                    )}
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

        {/* Rendered whenever there's anything to page through. Hidden on
            an empty result — "No customers" is already said above it. */}
        {rows.length > 0 && (
          <Pagination
            page={customers.data?.page ?? 1}
            totalPages={customers.data?.totalPages ?? 1}
            total={total}
            pageSize={customers.data?.pageSize ?? PAGE_SIZE}
            onPageChange={setPage}
            noun="customer"
            busy={customers.isFetching}
          />
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
          narrow strip and forced extra scrolling on a desktop browser.

          Flex column with p-0: the header and the form's action row stay
          put while only the middle scrolls. `overflow-hidden` keeps the
          scroll inside the body rather than on the dialog itself. */}
      <DialogContent className="flex max-h-[88vh] w-full max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-default px-6 py-4 pr-12">
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
