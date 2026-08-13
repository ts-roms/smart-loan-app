/**
 * Run the standing reconciliation against DATABASE_URL and print the
 * result as one JSON line, prefixed so the caller can find it amid any
 * Prisma log noise:
 *
 *   RECONCILIATION_JSON:{"ranAt":"...","ok":true,"checks":[...]}
 *
 * This is the write journey's closing argument. The five checks in
 * `libs/db/src/lib/reconciliation.ts` are the exact ones the nightly
 * job runs against production books — trial balance, per-entry
 * balance, duplicate source refs, schedule bounds, GL-vs-subledger.
 * A UI-driven apply → approve → disburse → pay that leaves all five
 * green has proved the thing the journey exists to prove: the flow
 * writes books that reconcile.
 *
 * The REAL function is imported, deliberately — a reimplementation
 * here could agree with itself while disagreeing with the job whose
 * verdict actually matters.
 *
 * Exit code: 0 when every check passes, 1 when any fails, 2 on
 * operational error (unreachable database). The caller asserts on the
 * JSON either way — the exit code is for humans running this by hand.
 *
 * Run with tsx from `libs/db` so `@prisma/client` resolves. `.mjs`
 * under `scripts/` for the boundary reason set out in `db-admin.mjs`.
 */
import { createPrismaClient } from "../../../../../libs/db/src/client.ts";
import { runReconciliation } from "../../../../../libs/db/src/lib/reconciliation.ts";

async function main() {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const result = await runReconciliation(prisma);
    console.log(`RECONCILIATION_JSON:${JSON.stringify(result)}`);
    process.exit(result.ok ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
