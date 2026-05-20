import type { LoanStatus } from '@loan/shared-types';
import { Badge } from '@loan/ui';

/**
 * Visual representation of a loan's status, used in both the list table
 * and the detail header. Re-exported via the feature's public index so
 * other surfaces (e.g. dashboard summary cards) can use the same mapping.
 */
export function LoanStatusBadge({ status }: { status: LoanStatus }) {
  const variant: 'success' | 'danger' | 'muted' | 'warning' =
    status === 'APPROVED' || status === 'DISBURSED' || status === 'ACTIVE' ? 'success' :
    status === 'REJECTED' || status === 'DEFAULTED' || status === 'CANCELLED' ? 'danger' :
    status === 'CLOSED' ? 'muted' :
    'warning';
  return <Badge variant={variant}>{status}</Badge>;
}
