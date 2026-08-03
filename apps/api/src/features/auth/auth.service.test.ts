/**
 * Auth service — self-registration and profile completion.
 *
 * Self-registration is deliberately split in two: `/auth/register`
 * creates a login with no borrower record, and `/auth/me/profile`
 * creates that record and links it. The whole design rests on one
 * invariant — a CUSTOMER with a null `customerId` can do nothing,
 * because `PortalService.resolveCustomerId` refuses them — so the
 * things worth pinning down here are the ones that would quietly
 * break it.
 *
 * Coverage:
 *   - `register` leaves `customerId` null. If it ever stopped doing
 *     that, the profile step would be skippable and accounts would
 *     reach the portal with no borrower record behind them.
 *   - `completeProfile` refuses a staff caller. Linking a Customer to
 *     a loan officer's login would scope their portal reads to one
 *     borrower and put staff somewhere they don't belong.
 *   - `completeProfile` refuses an already-linked account. A second
 *     Customer would strand the first as an orphan the borrower can't
 *     reach and staff meet again as a duplicate applicant.
 *   - Both refusals must also write nothing. A refusal that still
 *     issued the write would be worse than no check at all.
 *   - The Customer is created through the User relation, in one
 *     nested write, so the row and its link can't be committed apart.
 *   - Reference numbers come from the shared CUST-<year>-NNNNNN
 *     sequence, so self-registered borrowers interleave with the ones
 *     an officer keys in rather than starting a parallel series.
 */

import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";
import { completeProfileSchema } from "./schemas";

/** Minimal valid profile payload — every NOT NULL column on Customer. */
const VALID_PROFILE = {
  firstName: "Ana",
  lastName: "Cruz",
  dateOfBirth: "1994-05-21",
  phone: "09171234567",
  address: "12 Mabini St",
  city: "Quezon City",
  governmentIdType: "NATIONAL_ID" as const,
  governmentIdNumber: "NID-778899",
  employmentStatus: "EMPLOYED" as const,
  monthlyIncome: 42000,
};

interface MockOptions {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
    customerId: string | null;
  } | null;
  /** Highest existing CUST-<year>- number, or null when none exist. */
  lastCustomerNumber?: string | null;
  /** Existing user with the same email, for the register-conflict path. */
  emailTaken?: boolean;
}

function makeService(opts: MockOptions = {}) {
  const userFindUnique = vi.fn().mockImplementation(({ where }) => {
    // `register` looks up by email to detect a conflict; every other
    // path looks up by id. One mock serves both.
    if (where.email !== undefined) {
      return Promise.resolve(
        opts.emailTaken ? { id: "existing", email: where.email } : null,
      );
    }
    return Promise.resolve(opts.user ?? null);
  });

  // Echo the update back, merged onto the caller's user, so `digest`
  // sees a realistic row. The nested `customer.create` becomes a
  // customerId the same way Prisma would produce one.
  const userUpdate = vi.fn().mockImplementation(({ where, data }) => ({
    ...(opts.user ?? {}),
    id: where.id,
    name: data.name ?? opts.user?.name,
    customerId: data.customer?.create ? "cust-created" : opts.user?.customerId,
  }));

  const userCreate = vi.fn().mockImplementation(({ data }) => ({
    id: "user-new",
    email: data.email,
    name: data.name,
    role: data.role,
    // The column defaults to null and register never sets it — this is
    // the mock being faithful to the schema, not a convenience.
    customerId: null,
  }));

  const customerFindFirst = vi
    .fn()
    .mockResolvedValue(
      opts.lastCustomerNumber ? { number: opts.lastCustomerNumber } : null,
    );

  const prisma = {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
      create: userCreate,
    },
    customer: { findFirst: customerFindFirst },
    refreshToken: { create: vi.fn().mockResolvedValue({ id: "rt-1" }) },
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const signJwt = vi.fn().mockReturnValue("signed.jwt.token");
  const resolvePermissions = vi.fn().mockResolvedValue(new Set<string>());

  const service = new AuthService(
    prisma as never,
    audit as never,
    signJwt as never,
    resolvePermissions as never,
  );

  return { service, prisma, audit, userUpdate, userCreate, customerFindFirst };
}

describe("AuthService.register — leaves the account unlinked", () => {
  it("creates a CUSTOMER with a null customerId", async () => {
    // The gate that forces profile completion reads exactly this
    // field. A register path that populated it would let accounts into
    // the portal with no borrower record behind them.
    const { service } = makeService();
    const result = await service.register(
      { email: "new@example.ph", password: "P@ssw0rd123", name: "Ana Cruz" },
      "default",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.user.role).toBe("CUSTOMER");
    expect(result.user.customerId).toBeNull();
  });

  it("refuses an email that already has an account", async () => {
    const { service, userCreate } = makeService({ emailTaken: true });
    const result = await service.register(
      { email: "taken@example.ph", password: "P@ssw0rd123", name: "Ana" },
      "default",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("EmailExists");
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe("AuthService.completeProfile — refusals write nothing", () => {
  it("refuses when the user does not exist", async () => {
    const { service, userUpdate } = makeService({ user: null });
    const result = await service.completeProfile("user-ghost", VALID_PROFILE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a staff caller and creates no Customer", async () => {
    // Linking a borrower record to a loan officer would scope their
    // portal reads to that one Customer. Staff records are managed
    // through /rbac; this endpoint must not become a second way in.
    const { service, userUpdate, audit } = makeService({
      user: {
        id: "user-officer",
        email: "officer@loan.local",
        name: "Officer",
        role: "LOAN_OFFICER",
        customerId: null,
      },
    });
    const result = await service.completeProfile("user-officer", VALID_PROFILE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotACustomer");
    expect(userUpdate).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses an already-linked account rather than creating a second Customer", async () => {
    // A double submit or a stale tab. Creating another Customer would
    // strand the first: the borrower is linked to only one, so the
    // other becomes an orphan staff later meet as a duplicate.
    const { service, userUpdate } = makeService({
      user: {
        id: "user-linked",
        email: "member@example.ph",
        name: "Ana Cruz",
        role: "CUSTOMER",
        customerId: "cust-existing",
      },
    });
    const result = await service.completeProfile("user-linked", VALID_PROFILE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("AlreadyLinked");
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("AuthService.completeProfile — the successful write", () => {
  const unlinkedMember = {
    id: "user-member",
    email: "member@example.ph",
    name: "Ana Cruz",
    role: "CUSTOMER",
    customerId: null,
  };

  it("creates the Customer through the User relation, not as a separate insert", async () => {
    // One nested write means Prisma emits both statements in a single
    // transaction. Two independent creates could commit the Customer
    // and lose the link, leaving a record the borrower can't reach.
    const { service, userUpdate } = makeService({ user: unlinkedMember });
    const result = await service.completeProfile("user-member", VALID_PROFILE);

    expect(result.ok).toBe(true);
    const call = userUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: { customer?: { create?: Record<string, unknown> } };
    };
    expect(call.where.id).toBe("user-member");
    expect(call.data.customer?.create).toBeDefined();
  });

  it("returns the populated customerId, which is what lifts the portal gate", async () => {
    const { service } = makeService({ user: unlinkedMember });
    const result = await service.completeProfile("user-member", VALID_PROFILE);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.user.customerId).toBe("cust-created");
  });

  it("rebuilds the display name from the legal name parts", async () => {
    // Registration captured one free-text field; the profile form has
    // the real parts. If they drift, the portal header disagrees with
    // the loan documents.
    const { service, userUpdate } = makeService({ user: unlinkedMember });
    await service.completeProfile("user-member", {
      ...VALID_PROFILE,
      firstName: "Jose",
      lastName: "Bautista",
    });

    const call = userUpdate.mock.calls[0]![0] as { data: { name: string } };
    expect(call.data.name).toBe("Jose Bautista");
  });

  it("seeds the Customer email from the login when none is supplied", async () => {
    const { service, userUpdate } = makeService({ user: unlinkedMember });
    await service.completeProfile("user-member", VALID_PROFILE);

    const created = (
      userUpdate.mock.calls[0]![0] as {
        data: { customer: { create: { email: string } } };
      }
    ).data.customer.create;
    expect(created.email).toBe("member@example.ph");
  });

  it("prefers an explicitly supplied contact email over the login email", async () => {
    const { service, userUpdate } = makeService({ user: unlinkedMember });
    await service.completeProfile("user-member", {
      ...VALID_PROFILE,
      email: "other@example.ph",
    });

    const created = (
      userUpdate.mock.calls[0]![0] as {
        data: { customer: { create: { email: string } } };
      }
    ).data.customer.create;
    expect(created.email).toBe("other@example.ph");
  });

  it("converts the date-only birth date to a Date", async () => {
    const { service, userUpdate } = makeService({ user: unlinkedMember });
    await service.completeProfile("user-member", VALID_PROFILE);

    const created = (
      userUpdate.mock.calls[0]![0] as {
        data: { customer: { create: { dateOfBirth: Date } } };
      }
    ).data.customer.create;
    expect(created.dateOfBirth).toBeInstanceOf(Date);
    expect(created.dateOfBirth.toISOString()).toMatch(/^1994-05-21/);
  });

  it("audits the completion against the new Customer", async () => {
    const { service, audit } = makeService({ user: unlinkedMember });
    await service.completeProfile("user-member", VALID_PROFILE);

    expect(audit.record).toHaveBeenCalledOnce();
    const entry = audit.record.mock.calls[0]![0] as {
      action: string;
      actorId: string;
      targetId: string;
    };
    expect(entry.action).toBe("PORTAL_PROFILE_COMPLETED");
    expect(entry.actorId).toBe("user-member");
    expect(entry.targetId).toBe("cust-created");
  });
});

describe("AuthService.completeProfile — customer numbering", () => {
  const unlinkedMember = {
    id: "user-member",
    email: "member@example.ph",
    name: "Ana Cruz",
    role: "CUSTOMER",
    customerId: null,
  };

  const numberFrom = (userUpdate: { mock: { calls: unknown[][] } }) =>
    (
      userUpdate.mock.calls[0] as [
        { data: { customer: { create: { number: string } } } },
      ]
    )[0].data.customer.create.number;

  it("starts the year's sequence when no customers exist", async () => {
    const { service, userUpdate } = makeService({
      user: unlinkedMember,
      lastCustomerNumber: null,
    });
    await service.completeProfile("user-member", VALID_PROFILE);

    expect(numberFrom(userUpdate)).toMatch(/^CUST-\d{4}-000001$/);
  });

  it("continues the same sequence staff-created customers use", async () => {
    // Self-registered borrowers share one series with the ones an
    // officer keys in — a parallel sequence would collide on the
    // UNIQUE column and confuse anyone reading the numbers.
    const year = new Date().getFullYear();
    const { service, userUpdate } = makeService({
      user: unlinkedMember,
      lastCustomerNumber: `CUST-${year}-000041`,
    });
    await service.completeProfile("user-member", VALID_PROFILE);

    expect(numberFrom(userUpdate)).toBe(`CUST-${year}-000042`);
  });
});

describe("completeProfileSchema — the fields a loan file can't do without", () => {
  it("accepts the minimal valid payload", () => {
    expect(completeProfileSchema.safeParse(VALID_PROFILE).success).toBe(true);
  });

  it.each([
    "firstName",
    "lastName",
    "dateOfBirth",
    "phone",
    "address",
    "city",
    "governmentIdType",
    "governmentIdNumber",
    "employmentStatus",
    "monthlyIncome",
  ])("rejects a payload missing %s", (field) => {
    // Each of these is a NOT NULL column on Customer. Dropping one
    // from the schema wouldn't fail here — it would fail at the
    // insert, after the account already exists.
    const partial: Record<string, unknown> = { ...VALID_PROFILE };
    delete partial[field];
    expect(completeProfileSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a birth date in the future", () => {
    const result = completeProfileSchema.safeParse({
      ...VALID_PROFILE,
      dateOfBirth: "2099-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a timestamp where a date-only value belongs", () => {
    // Accepting a full timestamp invites a timezone shift that moves
    // someone's birthday across midnight.
    const result = completeProfileSchema.safeParse({
      ...VALID_PROFILE,
      dateOfBirth: "1994-05-21T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts zero income", () => {
    // UNEMPLOYED, RETIRED and STUDENT are all valid statuses. Forcing
    // a positive figure would put invented income in front of
    // underwriting.
    const result = completeProfileSchema.safeParse({
      ...VALID_PROFILE,
      employmentStatus: "UNEMPLOYED",
      monthlyIncome: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative income", () => {
    const result = completeProfileSchema.safeParse({
      ...VALID_PROFILE,
      monthlyIncome: -1,
    });
    expect(result.success).toBe(false);
  });
});
