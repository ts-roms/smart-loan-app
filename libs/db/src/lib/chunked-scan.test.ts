import { describe, expect, it } from "vitest";

import { forEachBookChunk, resumeAfter } from "./chunked-scan";

/**
 * The walk itself, tested apart from the three reports that use it.
 *
 * These are boundary tests, not behaviour tests: the reports' numbers are
 * pinned by whole-book-reads.golden.test.ts. What is checked here is that
 * the walk visits every row EXACTLY once, because both ways of getting
 * that wrong are silent. Skipping a row understates a band total; folding
 * one twice overstates it. Neither raises anything — they just produce a
 * slightly wrong number on a provisioning report, which is the worst
 * possible failure mode for this code.
 */

interface Row {
  id: string;
}

/** `n` rows with sortable ids, served the way a cursored findMany serves them. */
function source(n: number): {
  rows: Row[];
  fetch: (resumeAfterId: string | null, take: number) => Promise<Row[]>;
  calls: number[];
} {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(4, "0")}`,
  }));
  const calls: number[] = [];
  const fetch = (resumeAfterId: string | null, take: number) => {
    const args = resumeAfter(resumeAfterId);
    let out = [...rows];
    if (args.cursor) {
      const at = out.findIndex((r) => r.id === args.cursor!.id);
      out = at === -1 ? [] : out.slice(at);
    }
    if (args.skip !== undefined) out = out.slice(args.skip);
    out = out.slice(0, take);
    calls.push(out.length);
    return Promise.resolve(out);
  };
  return { rows, fetch, calls };
}

async function walk(n: number, chunkSize: number) {
  const { rows, fetch, calls } = source(n);
  const seen: string[] = [];
  await forEachBookChunk(
    fetch,
    (chunk) => seen.push(...chunk.map((r) => r.id)),
    chunkSize,
  );
  return { seen, expected: rows.map((r) => r.id), calls };
}

describe("forEachBookChunk", () => {
  it("visits every row exactly once when the last chunk is short", async () => {
    const { seen, expected } = await walk(25, 10);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(25);
  });

  it("visits every row exactly once when the count divides evenly", async () => {
    // The case that costs one extra empty round trip, and the case where
    // an off-by-one in the cursor would either duplicate or drop the row
    // on each chunk boundary.
    const { seen, expected, calls } = await walk(30, 10);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(30);
    expect(calls).toEqual([10, 10, 10, 0]);
  });

  it("handles a single short chunk", async () => {
    const { seen, expected, calls } = await walk(3, 10);
    expect(seen).toEqual(expected);
    expect(calls).toEqual([3]);
  });

  it("handles an empty book without calling the fold", async () => {
    const { fetch, calls } = source(0);
    let folded = 0;
    await forEachBookChunk(fetch, () => (folded += 1), 10);
    expect(folded).toBe(0);
    expect(calls).toEqual([0]);
  });

  it("handles a book of exactly one chunk", async () => {
    const { seen, expected, calls } = await walk(10, 10);
    expect(seen).toEqual(expected);
    expect(calls).toEqual([10, 0]);
  });
});

describe("resumeAfter", () => {
  it("is empty on the first call", () => {
    expect(resumeAfter(null)).toEqual({});
  });

  it("skips the cursor row, which Prisma includes", () => {
    // Without `skip: 1` the cursor row is re-folded once per chunk. On the
    // aging report that silently adds one instalment's balance per chunk
    // to a band total.
    expect(resumeAfter("id-0009")).toEqual({
      cursor: { id: "id-0009" },
      skip: 1,
    });
  });
});
