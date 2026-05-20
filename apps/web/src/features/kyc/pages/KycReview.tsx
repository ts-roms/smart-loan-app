import {
  useCustomers,
  useDecideKyc,
  useKycForCustomer,
} from '@loan/api-client';
import type { Customer, KycSubmission } from '@loan/shared-types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  usePrompt,
  useToast,
} from '@loan/ui';
import { formatDateTime } from '@loan/shared-utils';
import { ExternalLink, FileCheck2 } from 'lucide-react';
import { useMemo } from 'react';

import { DOC_TYPE_LABELS } from '../../customers';
import { KycInspectorLink } from '../components/KycInspectorDrawer';

/**
 * KYC queue for officers — every customer who has at least one PENDING
 * document. We fetch the list of customers (cheap) and then, for the
 * ones not yet verified, drill into their pack. Each pending document
 * gets an Approve/Reject inline button so the reviewer never has to
 * navigate away.
 */
export function KycReviewPage() {
  const customers = useCustomers();
  const pending = useMemo(
    () => (customers.data ?? []).filter((c) => c.kycStatus === 'PENDING' || c.kycStatus === 'NONE'),
    [customers.data],
  );

  if (customers.isLoading) return <SkeletonCard />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-emerald-300" />
          KYC review queue
        </CardTitle>
      </CardHeader>
      <CardContent>
        {pending.length === 0 ? (
          <p className="text-sm text-white/55">All customers are verified or rejected. </p>
        ) : (
          <div className="space-y-4">
            {pending.map((c) => (
              <CustomerKycBlock key={c.id} customer={c} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CustomerKycBlock({ customer }: { customer: Customer }) {
  const docs = useKycForCustomer(customer.id);
  const decide = useDecideKyc();
  const toast = useToast();
  const askPrompt = usePrompt();

  const onDecide = async (sub: KycSubmission, status: 'VERIFIED' | 'REJECTED') => {
    let reason: string | undefined;
    if (status === 'REJECTED') {
      const answer = await askPrompt({
        title: 'Reject this document?',
        message: 'The reason is shared with the customer so they can re-submit correctly.',
        label: 'Reason',
        placeholder: 'e.g. blurry image, expired ID',
        confirmLabel: 'Reject',
      });
      if (answer === null) return;
      reason = answer;
    }
    try {
      await decide.mutateAsync({
        id: sub.id,
        customerId: customer.id,
        status,
        reason,
      });
      toast.success(`${DOC_TYPE_LABELS[sub.documentType] ?? sub.documentType} ${status.toLowerCase()}`);
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <KycInspectorLink
          customerId={customer.id}
          customerName={`${customer.firstName} ${customer.lastName}`}
        >
          <span className="text-sm font-medium text-sky-300 hover:underline">
            {customer.firstName} {customer.lastName}
          </span>
        </KycInspectorLink>
        <div className="text-xs text-white/45">{customer.phone}</div>
      </div>
      {docs.isLoading ? (
        <p className="text-xs text-white/55">Loading docs…</p>
      ) : (docs.data ?? []).length === 0 ? (
        <p className="text-xs text-white/55">No documents submitted yet.</p>
      ) : (
        <ul className="divide-y divide-white/5">
          {(docs.data ?? []).map((d) => (
            <li key={d.id} className="py-2 flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{DOC_TYPE_LABELS[d.documentType] ?? d.documentType}</div>
                <div className="text-xs text-white/45">
                  {formatDateTime(d.submittedAt)} ·{' '}
                  <a
                    href={d.documentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-300 hover:underline inline-flex items-center gap-0.5"
                  >
                    view <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              {d.status === 'PENDING' ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onDecide(d, 'VERIFIED')}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => onDecide(d, 'REJECTED')}>
                    Reject
                  </Button>
                </div>
              ) : (
                <Badge variant={d.status === 'VERIFIED' ? 'success' : 'danger'}>
                  {d.status}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
