/**
 * Offset pagination helpers.
 *
 * These values come off a query string, so the cases that matter are the
 * malformed ones: a bookmarked `?page=0`, a hand-edited `?pageSize=99999`,
 * a `?page=abc` that coerces to NaN. Each has to produce a sane page
 * rather than a 400 or — worse — a NaN that reaches Prisma and fails at
 * the driver with an error nobody can trace back to a URL.
 */

import { describe, expect, it } from "vitest";

import { resolvePaging, toPage } from "./pagination";

const BOUNDS = { defaultPageSize: 200, maxPageSize: 500 };

describe("resolvePaging", () => {
  it("defaults to the first page at the caller's default size", () => {
    expect(resolvePaging({}, BOUNDS)).toEqual({
      skip: 0,
      take: 200,
      page: 1,
      pageSize: 200,
    });
  });

  it("turns a 1-indexed page into the right offset", () => {
    expect(resolvePaging({ page: 3, pageSize: 25 }, BOUNDS)).toEqual({
      skip: 50,
      take: 25,
      page: 3,
      pageSize: 25,
    });
  });

  it("clamps page 0 and negatives to the first page", () => {
    // A stale bookmark shouldn't produce a negative OFFSET.
    expect(resolvePaging({ page: 0 }, BOUNDS).page).toBe(1);
    expect(resolvePaging({ page: -5 }, BOUNDS).skip).toBe(0);
  });

  it("clamps an oversized pageSize to the maximum", () => {
    const resolved = resolvePaging({ pageSize: 100_000 }, BOUNDS);
    expect(resolved.pageSize).toBe(500);
    expect(resolved.take).toBe(500);
  });

  it("clamps a zero or negative pageSize up to one row", () => {
    expect(resolvePaging({ pageSize: 0 }, BOUNDS).pageSize).toBe(1);
    expect(resolvePaging({ pageSize: -10 }, BOUNDS).pageSize).toBe(1);
  });

  it("falls back rather than passing NaN through to the query", () => {
    const resolved = resolvePaging(
      { page: Number.NaN, pageSize: Number.NaN },
      BOUNDS,
    );
    expect(resolved.page).toBe(1);
    expect(resolved.pageSize).toBe(1);
    expect(Number.isFinite(resolved.skip)).toBe(true);
    expect(Number.isFinite(resolved.take)).toBe(true);
  });

  it("floors fractional input instead of handing Prisma a decimal", () => {
    expect(resolvePaging({ page: 2.7, pageSize: 25.9 }, BOUNDS)).toMatchObject({
      page: 2,
      pageSize: 25,
    });
  });
});

describe("toPage", () => {
  const resolved = resolvePaging({ page: 1, pageSize: 25 }, BOUNDS);

  it("reports the filter's total, not the size of this page", () => {
    const page = toPage(new Array(25).fill("row"), 130, resolved);
    expect(page.total).toBe(130);
    expect(page.totalPages).toBe(6);
  });

  it("rounds a partial last page up", () => {
    expect(toPage([], 26, resolved).totalPages).toBe(2);
  });

  it("reports one page when nothing matched", () => {
    // "Page 1 of 1" over an empty table reads better than "Page 1 of 0",
    // and keeps the control's arrows in a coherent state.
    const page = toPage([], 0, resolved);
    expect(page.totalPages).toBe(1);
    expect(page.rows).toEqual([]);
  });

  it("keeps the real total on a page past the end", () => {
    // The UI needs the count to work out where to send the operator back
    // to — silently serving the last page instead would be a page nobody
    // asked for.
    const past = resolvePaging({ page: 99, pageSize: 25 }, BOUNDS);
    const page = toPage([], 130, past);
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(130);
    expect(page.page).toBe(99);
    expect(page.totalPages).toBe(6);
  });
});
