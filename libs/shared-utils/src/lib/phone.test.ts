import { describe, expect, it } from "vitest";

import { formatPhone, isValidPhone, normalizePhone, phoneError } from "./phone";

describe("normalizePhone", () => {
  it("strips punctuation and spacing", () => {
    expect(normalizePhone("0917-123-4567")).toBe("09171234567");
    expect(normalizePhone("0917 123 4567")).toBe("09171234567");
    expect(normalizePhone("(02) 8123 4567")).toBe("0281234567");
  });

  it("resolves the country code to a leading zero", () => {
    // The same phone written three ways has to normalise to one
    // value, or one borrower registers twice.
    expect(normalizePhone("+639171234567")).toBe("09171234567");
    expect(normalizePhone("639171234567")).toBe("09171234567");
    expect(normalizePhone("+63 917 123 4567")).toBe("09171234567");
  });

  it("leaves a national number starting 63 alone", () => {
    // Only strips 63 when the length says it's a country code — a
    // landline that happens to start 63 keeps its digits.
    expect(normalizePhone("6312345678")).toBe("6312345678");
  });

  it("drops letters rather than accepting them", () => {
    expect(normalizePhone("0917abc4567")).toBe("09174567");
    expect(normalizePhone("not a number")).toBe("");
  });
});

describe("isValidPhone", () => {
  it("accepts the shapes people actually write", () => {
    expect(isValidPhone("09171234567")).toBe(true); // mobile, 11
    expect(isValidPhone("9171234567")).toBe(true); // mobile without 0, 10
    expect(isValidPhone("0281234567")).toBe(true); // landline, 10
    expect(isValidPhone("+639171234567")).toBe(true);
  });

  it("rejects anything outside 10–11 digits", () => {
    expect(isValidPhone("091712345")).toBe(false); // 9
    expect(isValidPhone("091712345678")).toBe(false); // 12
    expect(isValidPhone("")).toBe(false);
    expect(isValidPhone("abcdefghijk")).toBe(false);
  });
});

describe("phoneError", () => {
  it("says nothing when the number is fine", () => {
    expect(phoneError("0917 123 4567")).toBeNull();
  });

  it("counts the digits back so the message is actionable", () => {
    expect(phoneError("091712345")).toContain("you have 9");
    expect(phoneError("091712345678")).toContain("you have 12");
  });

  it("distinguishes empty from wrong", () => {
    expect(phoneError("")).toBe("Enter a phone number");
    expect(phoneError("   ")).toBe("Enter a phone number");
    expect(phoneError("abc")).toBe("Enter a phone number");
    expect(phoneError("0917")).toContain("Too short");
  });
});

describe("formatPhone", () => {
  it("groups a mobile and a landline differently", () => {
    expect(formatPhone("09171234567")).toBe("0917 123 4567");
    expect(formatPhone("0281234567")).toBe("02 8123 4567");
  });

  it("passes through anything it can't parse", () => {
    // Legacy rows predate the rule; mangling them on the way to the
    // screen would lose information the operator needs to fix it.
    expect(formatPhone("123")).toBe("123");
    expect(formatPhone("ext. 4021")).toBe("ext. 4021");
  });
});
