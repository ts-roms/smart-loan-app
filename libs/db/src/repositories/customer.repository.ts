import type {
  CivilStatus,
  Customer,
  EmploymentStatus,
  Gender,
  GovernmentIdType,
  LoanStatus,
  PrismaClient,
  Sex,
} from "@prisma/client";
import { idOrNumberWhere, nextCustomerNumber } from "../lib/reference-numbers";

/**
 * Input shape for creating a customer. Mirrors the expanded schema —
 * personal + contact + address + civil status + employment. Most
 * fields are optional so partial registrations from older forms still
 * work; the route's zod schema enforces conditional requireds
 * (e.g. spouseName when MARRIED).
 */
export interface CustomerCreateInput {
  // Personal
  firstName: string;
  middleName?: string;
  lastName: string;
  suffix?: string;
  dateOfBirth: Date;
  gender?: Gender;
  sex?: Sex;
  civilStatus?: CivilStatus;

  // Contact
  phone: string;
  secondaryPhone?: string;
  email?: string;

  // Address (PSGC hierarchy)
  address: string;
  addressLine2?: string;
  barangay?: string;
  city: string;
  province?: string;
  region?: string;
  postalCode?: string;

  // Spouse — only populated when civilStatus === MARRIED
  spouseName?: string;
  spouseDateOfBirth?: Date;
  spouseContact?: string;
  spouseOccupation?: string;

  // Government ID
  governmentIdType: GovernmentIdType;
  governmentIdNumber: string;

  // Employment
  employmentStatus: EmploymentStatus;
  employerName?: string;
  jobTitle?: string;
  position?: string;
  hireDate?: Date;
  regularizationDate?: Date;
  monthlyIncome: number;
  yearsAtCurrentJob?: number;
}

export type CustomerUpdateInput = Partial<CustomerCreateInput>;

/**
 * Loan statuses that make a customer count as "already borrowing" for
 * the {@link CustomerListItem.hasLoans} flag: approved-but-not-yet-
 * disbursed, disbursed, and in-repayment.
 *
 * Everything else is deliberately excluded. DRAFT / SUBMITTED /
 * UNDER_REVIEW haven't been granted yet; REJECTED and CANCELLED never
 * became loans; CLOSED / DEFAULTED / RESTRUCTURED / WRITTEN_OFF are
 * finished, so the customer has nothing running today. A borrower whose
 * only loan is in one of those states reads as a first-timer here — the
 * repeat-eligibility endpoint is the place that looks at loan history.
 */
const ACTIVE_LOAN_STATUSES: readonly LoanStatus[] = [
  "APPROVED",
  "DISBURSED",
  "ACTIVE",
];

/**
 * Loan statuses that mark a customer as having burned the lender:
 * DEFAULTED (missed too many payments) and WRITTEN_OFF (collection
 * abandoned, principal booked to Bad Debt).
 *
 * RESTRUCTURED is *not* here — the original loan is terminal because it
 * was replaced by a new one, which is a workout, not a loss.
 */
const DEFAULTED_LOAN_STATUSES: readonly LoanStatus[] = [
  "DEFAULTED",
  "WRITTEN_OFF",
];

/**
 * A customer row as served by the list endpoint: the full record plus
 * two cheap risk markers — is there a live loan on this person, and have
 * they ever defaulted.
 *
 * The flags exist so pickers (New Loan's borrower step, in particular)
 * can rank and warn without every caller pulling the entire `/loans`
 * collection just to diff customer ids. Only loans in the statuses above
 * are fetched, and only their `status` column — the query stays small
 * regardless of how much history a borrower has.
 */
export type CustomerListItem = Customer & {
  hasLoans: boolean;
  hasDefaulted: boolean;
};

export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(): Promise<CustomerListItem[]> {
    const rows = await this.prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        // Statuses only — two independent flags can't come from a single
        // `_count` (Prisma allows one filter per relation), so we pull the
        // handful of interesting rows and fold them below.
        loanApplications: {
          where: {
            status: {
              in: [...ACTIVE_LOAN_STATUSES, ...DEFAULTED_LOAN_STATUSES],
            },
          },
          select: { status: true },
        },
      },
    });
    // Fold the relation away so the wire payload stays a plain customer
    // record plus two booleans. Callers that need real counts or amounts
    // use /customers/:id/summary.
    return rows.map(({ loanApplications, ...customer }) => ({
      ...customer,
      hasLoans: loanApplications.some((l) =>
        ACTIVE_LOAN_STATUSES.includes(l.status),
      ),
      hasDefaulted: loanApplications.some((l) =>
        DEFAULTED_LOAN_STATUSES.includes(l.status),
      ),
    }));
  }

  findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  /**
   * Resolve a customer by either UUID or human number ("CUST-2026-..."),
   * so API routes can accept either form on the path. Returns null if
   * neither matches — same shape as findById.
   */
  findByIdOrNumber(idOrNumber: string): Promise<Customer | null> {
    return this.prisma.customer.findFirst({
      where: idOrNumberWhere(idOrNumber),
    });
  }

  async create(input: CustomerCreateInput): Promise<Customer> {
    // Generate the human reference number at create time. The DB column
    // is NOT NULL + UNIQUE so a missing number would error — surfacing
    // the contract here in code is friendlier than waiting for Prisma.
    const number = await nextCustomerNumber(this.prisma);
    return this.prisma.customer.create({ data: { ...input, number } });
  }

  update(id: string, input: CustomerUpdateInput): Promise<Customer> {
    return this.prisma.customer.update({ where: { id }, data: input });
  }

  /**
   * Per-row result for bulk import. Successful rows return the created
   * customer's `id` + human `number`; failed rows return `error`. The
   * caller decides whether a partial failure aborts the batch.
   */
  // bulk results live in shared-types-friendly shape — string ids only

  // (kept colocated with the create method so the schema is obvious)

  /**
   * Bulk-create customers. Each row runs through `create` independently
   * — a single bad row doesn't poison the rest. Failed rows are reported
   * with the validation / prisma message; successful rows still commit.
   *
   * Pass `stopOnError:true` to short-circuit at the first failure. The
   * row index in the response always reflects the original CSV order so
   * the operator can find the offending line.
   */
  async bulkCreate(
    rows: CustomerCreateInput[],
    opts: { stopOnError?: boolean } = {},
  ): Promise<BulkCustomerRowResult[]> {
    const out: BulkCustomerRowResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      try {
        const created = await this.create(row);
        out.push({
          index: i,
          ok: true,
          id: created.id,
          number: created.number,
        });
      } catch (err) {
        out.push({
          index: i,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        if (opts.stopOnError) break;
      }
    }
    return out;
  }
}

/**
 * Per-row result for {@link CustomerRepository.bulkCreate}. The shape is
 * stable across HTTP — the route just JSON-encodes it directly.
 */
export interface BulkCustomerRowResult {
  index: number;
  ok: boolean;
  id?: string;
  number?: string;
  error?: string;
}
