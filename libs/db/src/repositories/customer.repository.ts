import type {
  CivilStatus,
  Customer,
  EmploymentStatus,
  Gender,
  GovernmentIdType,
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

export class CustomerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<Customer[]> {
    return this.prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });
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
  /* eslint-disable-next-line */
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
