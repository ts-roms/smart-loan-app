import { useCustomerSummary } from "@loan/api-client";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  SkeletonLine,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  ArrowUpRight,
  CreditCard,
  ShieldCheck,
  UserCircle,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { LoanStatusBadge } from "../../loans";

/**
 * Click-to-inspect wrapper for any customer id. Wraps a child trigger
 * (usually the customer's name); clicking opens a right-side drawer with
 * contact, KYC status, active loans count, total outstanding, and a quick
 * link to the full profile.
 *
 * Usage:
 *   <CustomerSummaryLink customerId={c.id}>
 *     {fullName}
 *   </CustomerSummaryLink>
 */
export function CustomerSummaryLink({
  customerId,
  children,
}: {
  customerId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!customerId) return <>{children}</>;
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 rounded"
          aria-label="Open customer summary"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <CustomerSummaryInspector customerId={customerId} />
      </DrawerContent>
    </Drawer>
  );
}

function CustomerSummaryInspector({ customerId }: { customerId: string }) {
  const summary = useCustomerSummary(customerId);

  if (summary.isLoading) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Customer</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </DrawerBody>
      </>
    );
  }
  if (!summary.data) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Customer</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <p className="text-sm text-white/55">Customer not found.</p>
        </DrawerBody>
      </>
    );
  }

  const {
    customer,
    activeLoansCount,
    totalLoansCount,
    outstanding,
    activeLoans,
  } = summary.data;
  const fullName = [customer.firstName, customer.middleName, customer.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <UserCircle className="h-5 w-5 mt-0.5 text-sky-300" />
          <div className="flex-1 min-w-0">
            {/* Reference number leads — that's how operators identify
                the row in conversation and audit notes. */}
            <div className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              {customer.number}
            </div>
            <DrawerTitle>{fullName}</DrawerTitle>
            <DrawerDescription>
              {customer.email ?? "—"} · {customer.phone}
              <br />
              <span className="font-mono">
                {customer.governmentIdType} {customer.governmentIdNumber}
              </span>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* KYC + employment */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/45">
              <ShieldCheck className="h-3 w-3" />
              KYC
            </div>
            <div className="mt-1">
              <Badge
                variant={
                  customer.kycStatus === "VERIFIED"
                    ? "success"
                    : customer.kycStatus === "REJECTED"
                      ? "danger"
                      : customer.kycStatus === "PENDING"
                        ? "warning"
                        : "muted"
                }
              >
                {customer.kycStatus}
              </Badge>
            </div>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
            <div className="text-[10px] uppercase tracking-wider text-white/45">
              Employment
            </div>
            <div className="text-xs text-white mt-1">
              {customer.employmentStatus}
            </div>
            <div className="text-[10px] text-white/55 truncate">
              {customer.employerName ?? "—"}
            </div>
          </div>
        </div>

        {/* Loan rollup */}
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Active loans" value={String(activeLoansCount)} />
          <Stat label="Total loans" value={String(totalLoansCount)} />
          <Stat label="Outstanding" value={formatMoney(outstanding)} />
        </div>

        {/* Active loans list */}
        {activeLoans.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5 flex items-center gap-1">
              <CreditCard className="h-3 w-3" />
              Active loans
            </div>
            <div className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
              {activeLoans.map((l) => (
                <Link
                  key={l.id}
                  to={`/loans/${l.number}`}
                  className="px-2.5 py-1.5 text-xs flex items-center justify-between hover:bg-white/[0.03]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-sky-300">{l.number}</span>
                    <LoanStatusBadge status={l.status} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-white/65">
                      {formatMoney(Number(l.principal))}
                    </span>
                    {l.disbursedAt && (
                      <span className="text-[10px] text-white/45">
                        {formatDate(l.disbursedAt)}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Address */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1">
            Address
          </div>
          <p className="text-xs text-white/75">
            {customer.address}, {customer.city}
            {customer.province ? `, ${customer.province}` : ""}
            {customer.postalCode ? ` ${customer.postalCode}` : ""}
          </p>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <Link
            to={`/customers/${customer.number}`}
            className="inline-flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open full profile
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className="font-mono text-sm mt-0.5">{value}</div>
    </div>
  );
}
