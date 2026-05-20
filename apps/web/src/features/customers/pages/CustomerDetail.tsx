import {
  useCustomer,
  useCustomerScore,
  useKycForCustomer,
  useKycStatus,
  useSubmitKyc,
} from '@loan/api-client';
import type { CreditTier, KycDocumentType } from '@loan/shared-types';
import {
  Badge,
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
} from '@loan/ui';
import { formatDate, formatMoney } from '@loan/shared-utils';
import { FileUp, Gauge, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

const DOC_TYPES: { value: KycDocumentType; label: string }[] = [
  { value: 'ID_FRONT', label: 'Government ID (front)' },
  { value: 'ID_BACK', label: 'Government ID (back)' },
  { value: 'PROOF_OF_INCOME', label: 'Proof of income' },
  { value: 'PROOF_OF_ADDRESS', label: 'Proof of address' },
  { value: 'SELFIE', label: 'Selfie holding ID' },
  { value: 'VEHICLE_OR', label: 'Vehicle OR (Official Receipt)' },
  { value: 'VEHICLE_CR', label: 'Vehicle CR (Certificate of Registration)' },
  { value: 'PROPERTY_TITLE', label: 'Property title (TCT/Condo cert)' },
  { value: 'TAX_DECLARATION', label: 'Tax declaration' },
];

export const DOC_TYPE_LABELS: Record<KycDocumentType, string> = Object.fromEntries(
  DOC_TYPES.map((d) => [d.value, d.label]),
) as Record<KycDocumentType, string>;

/**
 * Per-customer drill-down: profile, KYC pack with submit-doc form,
 * current credit score (with tier + breakdown), and CTAs to (re)take
 * the credit-scoring survey or apply for a loan.
 */
export function CustomerDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const customer = useCustomer(id);
  const kycDocs = useKycForCustomer(id);
  const kycStatus = useKycStatus(id);
  const score = useCustomerScore(id);

  if (customer.isLoading) return <SkeletonCard />;
  if (!customer.data) return <p className="text-sm text-white/55">Customer not found.</p>;
  const c = customer.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>
              {c.firstName} {c.middleName ? `${c.middleName} ` : ''}{c.lastName}
            </CardTitle>
            <div className="text-xs text-white/55 mt-1">
              {c.phone} · {c.email ?? '—'} · DOB {formatDate(c.dateOfBirth)}
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              to={`/customers/${id}/survey`}
              className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.06] px-3 py-1.5 text-sm hover:bg-white/[0.10]"
            >
              <Gauge className="h-4 w-4" />
              {score.data ? 'Re-score' : 'Take credit survey'}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Info label="Address">{c.address}, {c.city}{c.province ? `, ${c.province}` : ''}</Info>
          <Info label="Gov't ID">{c.governmentIdType} · {c.governmentIdNumber}</Info>
          <Info label="Employment">{c.employmentStatus}{c.jobTitle ? ` · ${c.jobTitle}` : ''}</Info>
          <Info label="Monthly income">{formatMoney(Number(c.monthlyIncome))}</Info>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-sky-300" />
              Credit score
            </CardTitle>
          </CardHeader>
          <CardContent>
            {score.isLoading ? (
              <p className="text-sm text-white/55">Loading…</p>
            ) : score.data ? (
              <div className="space-y-3">
                <div className="flex items-end gap-3">
                  <div className="text-4xl font-semibold tracking-tight">{score.data.score}</div>
                  <TierBadge tier={score.data.tier} />
                </div>
                <div className="text-xs text-white/55">
                  Last scored {formatDate(score.data.computedAt)}
                </div>
                <ul className="text-xs divide-y divide-white/5">
                  {score.data.breakdown.slice(0, 6).map((b) => (
                    <li key={b.factorId} className="flex justify-between py-1.5">
                      <span className="text-white/70">{b.label}</span>
                      <span className="font-mono">
                        {b.points.toFixed(1)} / {b.maxPoints}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-white/55">No score yet — run the survey.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
              KYC
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {kycStatus.data && (
              <div className="text-sm">
                Rollup status:{' '}
                <Badge variant={
                  kycStatus.data.status === 'VERIFIED' ? 'success' :
                  kycStatus.data.status === 'REJECTED' ? 'danger' :
                  kycStatus.data.status === 'PENDING' ? 'warning' : 'muted'
                }>
                  {kycStatus.data.status}
                </Badge>
                {kycStatus.data.missing.length > 0 && (
                  <div className="text-xs text-amber-300 mt-1">
                    Missing: {kycStatus.data.missing.map((m) => DOC_TYPE_LABELS[m]).join(', ')}
                  </div>
                )}
              </div>
            )}
            <ul className="text-xs divide-y divide-white/5">
              {(kycDocs.data ?? []).map((d) => (
                <li key={d.id} className="py-1.5 flex justify-between">
                  <span>{DOC_TYPE_LABELS[d.documentType] ?? d.documentType}</span>
                  <Badge variant={
                    d.status === 'VERIFIED' ? 'success' :
                    d.status === 'REJECTED' ? 'danger' : 'warning'
                  }>
                    {d.status}
                  </Badge>
                </li>
              ))}
            </ul>
            <SubmitKycForm customerId={id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SubmitKycForm({ customerId }: { customerId: string }) {
  const submit = useSubmitKyc();
  const toast = useToast();
  const [documentType, setDocumentType] = useState<KycDocumentType>('ID_FRONT');
  const [documentUrl, setDocumentUrl] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await submit.mutateAsync({ customerId, documentType, documentUrl });
      toast.success('Document submitted');
      setDocumentUrl('');
    } catch (err) {
      toast.error((err as Error).message ?? 'Could not submit');
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-2 border-t border-white/10 pt-3">
      <div className="text-xs text-white/55 flex items-center gap-1">
        <FileUp className="h-3 w-3" />
        Submit a document
      </div>
      <Select value={documentType} onValueChange={(v) => setDocumentType(v as KycDocumentType)}>
        <SelectTrigger className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DOC_TYPES.map((t) => (
            <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        placeholder="Document URL (uploaded asset)"
        value={documentUrl}
        onChange={(e) => setDocumentUrl(e.target.value)}
        required
      />
      <Button type="submit" size="sm" className="w-full" disabled={submit.isPending || !documentUrl}>
        {submit.isPending ? 'Submitting…' : 'Submit document'}
      </Button>
    </form>
  );
}

function TierBadge({ tier }: { tier: CreditTier }) {
  const map: Record<CreditTier, { cls: string; label: string }> = {
    A: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30', label: 'A · Prime' },
    B: { cls: 'bg-sky-500/15 text-sky-300 border-sky-400/30', label: 'B · Good' },
    C: { cls: 'bg-amber-500/15 text-amber-200 border-amber-400/30', label: 'C · Fair' },
    D: { cls: 'bg-orange-500/15 text-orange-300 border-orange-400/30', label: 'D · Subprime' },
    F: { cls: 'bg-rose-500/15 text-rose-300 border-rose-400/30', label: 'F · Decline' },
  };
  return (
    <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${map[tier].cls}`}>
      {map[tier].label}
    </span>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
