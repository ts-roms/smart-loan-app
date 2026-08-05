/**
 * Declaration validation + snapshotting.
 *
 * The rules worth pinning:
 *   • Partial answers are valid at submit (missing ≠ invalid) — the gate
 *     is at approval, and the two must not be conflated.
 *   • Malformed answers are always invalid, whatever the gate.
 *   • The approval gate reads the SNAPSHOT, not the live questions — an
 *     admin adding a required question tomorrow must not retroactively
 *     block yesterday's application.
 */

import { describe, expect, it } from "vitest";

import {
  declarationsComplete,
  snapshotDeclarations,
  validateDeclarations,
  type KycQuestion,
} from "./declarations";

const QUESTIONS: KycQuestion[] = [
  {
    id: "source_of_funds",
    label: "Source of funds?",
    type: "SELECT",
    options: ["Salary", "Business", "Remittance"],
    required: true,
  },
  {
    id: "is_pep",
    label: "Are you a politically exposed person?",
    type: "YES_NO",
    required: true,
  },
  {
    id: "purpose_detail",
    label: "Describe the purpose",
    type: "TEXT",
    required: false,
  },
  {
    id: "dependents",
    label: "Number of dependents",
    type: "NUMBER",
    required: false,
  },
];

describe("validateDeclarations", () => {
  it("accepts complete, well-formed answers", () => {
    const v = validateDeclarations(QUESTIONS, {
      source_of_funds: "Salary",
      is_pep: false,
      dependents: 2,
    });
    expect(v).toEqual({ complete: true, missing: [], invalid: [] });
  });

  it("reports missing required answers without marking them invalid", () => {
    const v = validateDeclarations(QUESTIONS, { is_pep: true });
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(["source_of_funds"]);
    expect(v.invalid).toEqual([]);
  });

  it("rejects type mismatches", () => {
    const v = validateDeclarations(QUESTIONS, {
      source_of_funds: "Salary",
      is_pep: "yes", // string, not boolean
      dependents: "two", // string, not number
    });
    expect(v.invalid.map((i) => i.id).sort()).toEqual(["dependents", "is_pep"]);
  });

  it("rejects a SELECT answer outside the offered options", () => {
    const v = validateDeclarations(QUESTIONS, {
      source_of_funds: "Crypto",
      is_pep: false,
    });
    expect(v.invalid[0]?.id).toBe("source_of_funds");
  });

  it("ignores answers to questions that no longer exist", () => {
    // Admin removed a question between form render and submit — the
    // borrower shouldn't eat an error for that race.
    const v = validateDeclarations(QUESTIONS, {
      source_of_funds: "Salary",
      is_pep: false,
      removed_question: "whatever",
    });
    expect(v.invalid).toEqual([]);
  });

  it("treats empty string as unanswered, not as a text answer", () => {
    const v = validateDeclarations(QUESTIONS, {
      source_of_funds: "",
      is_pep: false,
    });
    expect(v.missing).toEqual(["source_of_funds"]);
  });
});

describe("snapshotDeclarations", () => {
  it("freezes every question with its answer or null", () => {
    const snap = snapshotDeclarations(
      QUESTIONS,
      { source_of_funds: "Business", is_pep: false },
      { id: "user-1" },
    );
    expect(snap.items).toHaveLength(4);
    expect(snap.items[0]).toMatchObject({
      id: "source_of_funds",
      label: "Source of funds?",
      answer: "Business",
    });
    // Asked but unanswered — recorded as such, not dropped.
    expect(snap.items[2]).toMatchObject({ id: "purpose_detail", answer: null });
    expect(snap.answeredById).toBe("user-1");
    expect(snap.answeredAt).not.toBeNull();
  });

  it("leaves attribution null when nothing was answered", () => {
    const snap = snapshotDeclarations(QUESTIONS, {}, { id: "user-1" });
    expect(snap.answeredAt).toBeNull();
    expect(snap.answeredById).toBeNull();
  });
});

describe("declarationsComplete", () => {
  it("reads the snapshot, not the live questions", () => {
    const snap = snapshotDeclarations(
      QUESTIONS,
      { source_of_funds: "Salary", is_pep: true },
      { id: "u" },
    );
    expect(declarationsComplete(snap).complete).toBe(true);
  });

  it("flags unanswered required items in the snapshot", () => {
    const snap = snapshotDeclarations(QUESTIONS, {}, null);
    const { complete, missing } = declarationsComplete(snap);
    expect(complete).toBe(false);
    expect(missing.map((m) => m.id).sort()).toEqual([
      "is_pep",
      "source_of_funds",
    ]);
  });

  it("treats no snapshot at all as complete", () => {
    // Products with no questionnaire configured — which is every product
    // until an admin builds one — must not gate approval.
    expect(declarationsComplete(null).complete).toBe(true);
    expect(declarationsComplete(undefined).complete).toBe(true);
  });
});
