import { useCreateCustomer, useCustomers } from '@loan/api-client';
import type { CustomerCreateInput, KycStatus } from '@loan/shared-types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SkeletonCard,
  useToast,
} from '@loan/ui';
import { formatMoney } from '@loan/shared-utils';
import { Plus, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { CustomerSummaryLink } from '../components/CustomerSummaryDrawer';

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
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          New customer
        </Button>
      </CardHeader>
      <CardContent>
        {customers.isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
          </div>
        ) : (customers.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No customers yet. Add one to get started.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Phone</th>
                <th className="py-2 px-2">Income</th>
                <th className="py-2 px-2">KYC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(customers.data ?? []).map((c) => (
                <tr key={c.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2">
                    <CustomerSummaryLink customerId={c.id}>
                      <span className="text-sky-300 hover:underline">
                        {c.firstName} {c.lastName}
                      </span>
                    </CustomerSummaryLink>
                  </td>
                  <td className="py-2 px-2 font-mono text-xs">{c.phone}</td>
                  <td className="py-2 px-2">{formatMoney(Number(c.monthlyIncome))}/mo</td>
                  <td className="py-2 px-2"><KycBadge status={c.kycStatus} /></td>
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
  const map: Record<KycStatus, { variant: 'muted' | 'warning' | 'success' | 'danger'; label: string }> = {
    NONE: { variant: 'muted', label: 'None' },
    PENDING: { variant: 'warning', label: 'Pending' },
    VERIFIED: { variant: 'success', label: 'Verified' },
    REJECTED: { variant: 'danger', label: 'Rejected' },
  };
  const { variant, label } = map[status];
  return <Badge variant={variant}>{label}</Badge>;
}

function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCustomer();
  const toast = useToast();
  const [form, setForm] = useState<CustomerCreateInput>({
    firstName: '',
    lastName: '',
    dateOfBirth: '',
    phone: '',
    address: '',
    city: '',
    governmentIdType: 'NATIONAL_ID',
    governmentIdNumber: '',
    employmentStatus: 'EMPLOYED',
    monthlyIncome: 0,
  });

  const set = <K extends keyof CustomerCreateInput>(key: K, val: CustomerCreateInput[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync(form);
      toast.success('Customer added');
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? 'Could not create');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New customer
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name">
              <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} required />
            </Field>
            <Field label="Last name">
              <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} required />
            </Field>
            <Field label="Date of birth">
              <DatePicker
                value={form.dateOfBirth}
                onChange={(v) => set('dateOfBirth', v)}
                max={new Date().toISOString().slice(0, 10)}
                placeholder="Date of birth"
              />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} required />
            </Field>
            <Field label="Address" className="col-span-2">
              <Input value={form.address} onChange={(e) => set('address', e.target.value)} required />
            </Field>
            <Field label="City">
              <Input value={form.city} onChange={(e) => set('city', e.target.value)} required />
            </Field>
            <Field label="Gov't ID #">
              <Input value={form.governmentIdNumber} onChange={(e) => set('governmentIdNumber', e.target.value)} required />
            </Field>
            <Field label="Monthly income (₱)">
              <Input
                type="number"
                min={0}
                value={form.monthlyIncome}
                onChange={(e) => set('monthlyIncome', Number(e.target.value))}
                required
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Create customer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
