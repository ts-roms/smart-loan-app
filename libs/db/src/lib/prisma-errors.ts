/**
 * Prisma error predicates.
 *
 * These exist so the repositories can let the DATABASE arbitrate a race
 * and then react to the result, rather than pre-checking and hoping
 * nothing happens in between. Several financial paths depend on it:
 * journal auto-posting, payment idempotency.
 */

/**
 * A unique-constraint violation, as Prisma reports it.
 *
 * Matched structurally rather than with `instanceof
 * PrismaClientKnownRequestError`. Under pnpm the API and the
 * repositories can resolve separate copies of @prisma/client, and an
 * instanceof check across two copies silently returns false — which
 * here would turn a handled race into a 500.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
