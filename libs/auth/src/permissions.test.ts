/**
 * The permission catalog and the default role definitions.
 *
 * These are plain data, which is exactly why they're worth testing: nothing
 * validates them at runtime. A typo in a role's permission list produces a
 * key that exists nowhere in the catalog, so the permission can never be
 * granted and every route behind it denies forever — silently, and only for
 * the roles that were supposed to have it.
 *
 * The other class these guard against is privilege creep: a permission
 * quietly added to a role that shouldn't hold it. Least-privilege is easy to
 * state and easy to erode, so the boundaries are asserted rather than
 * assumed.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROLES,
  DEFAULT_ROLE_BY_KEY,
  PERMISSIONS,
  PERMISSIONS_BY_CATEGORY,
  PERMISSION_KEYS,
} from "./permissions";

describe("permission catalog", () => {
  it("has no duplicate keys", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    // A duplicate would make PERMISSION_KEYS smaller than PERMISSIONS and
    // leave whichever definition lost the race silently unused.
    expect(dupes, `duplicate permission keys: ${dupes.join(", ")}`).toEqual([]);
  });

  it("exposes every permission through PERMISSION_KEYS", () => {
    expect(PERMISSION_KEYS.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) {
      expect(PERMISSION_KEYS.has(p.key), `${p.key} missing from the set`).toBe(
        true,
      );
    }
  });

  it("indexes every permission under exactly one category", () => {
    const indexed = Object.values(PERMISSIONS_BY_CATEGORY).flat();
    expect(indexed).toHaveLength(PERMISSIONS.length);
    const keys = indexed.map((p) => p.key).sort();
    expect(keys).toEqual(PERMISSIONS.map((p) => p.key).sort());
  });

  it("uses the `area.action` key shape throughout", () => {
    // The route guards and the RBAC UI both split on the dot; a key without
    // one would group under an empty area and read as unlabelled.
    for (const p of PERMISSIONS) {
      expect(p.key, `${p.key} is not area.action`).toMatch(
        /^[a-z][a-z_]*\.[a-z][a-z_.]*$/,
      );
    }
  });

  it("gives every permission a non-empty label", () => {
    for (const p of PERMISSIONS) {
      expect(p.label?.trim(), `${p.key} has no label`).toBeTruthy();
    }
  });
});

describe("default roles", () => {
  it("only grants permissions that exist in the catalog", () => {
    // The failure this catches: a role lists `customers.wrtie`, the route
    // requires `customers.write`, and that role is denied forever with no
    // error anywhere. Fails closed, which makes it easy to miss.
    for (const role of DEFAULT_ROLES) {
      for (const key of role.permissions) {
        expect(
          PERMISSION_KEYS.has(key),
          `role ${role.key} grants "${key}", which is not in the catalog`,
        ).toBe(true);
      }
    }
  });

  it("lists no permission twice within a role", () => {
    for (const role of DEFAULT_ROLES) {
      const dupes = role.permissions.filter(
        (k, i) => role.permissions.indexOf(k) !== i,
      );
      expect(dupes, `${role.key} repeats: ${dupes.join(", ")}`).toEqual([]);
    }
  });

  it("has unique role keys, and DEFAULT_ROLE_BY_KEY agrees with the list", () => {
    const keys = DEFAULT_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const role of DEFAULT_ROLES) {
      expect(DEFAULT_ROLE_BY_KEY[role.key]).toEqual(role);
    }
    expect(Object.keys(DEFAULT_ROLE_BY_KEY).sort()).toEqual([...keys].sort());
  });

  it("marks the canonical roles as system roles", () => {
    for (const key of ["ADMIN", "LOAN_OFFICER", "ACCOUNTANT", "CUSTOMER"]) {
      const role = DEFAULT_ROLE_BY_KEY[key];
      expect(role, `${key} is missing`).toBeDefined();
      // System roles can't be deleted through the API; losing the flag would
      // make a core role removable.
      expect(role!.system, `${key} should be a system role`).toBe(true);
    }
  });
});

describe("least privilege", () => {
  const perms = (key: string) => DEFAULT_ROLE_BY_KEY[key]?.permissions ?? [];

  it("gives ADMIN the whole catalog", () => {
    expect([...perms("ADMIN")].sort()).toEqual(
      PERMISSIONS.map((p) => p.key).sort(),
    );
  });

  it("limits CUSTOMER to self-service only", () => {
    // A CUSTOMER account is a borrower with a valid tenant JWT. Anything
    // beyond portal.self here is reachable by every borrower.
    expect(perms("CUSTOMER")).toEqual(["portal.self"]);
  });

  it("keeps admin.* out of every non-admin role", () => {
    for (const role of DEFAULT_ROLES) {
      if (role.key === "ADMIN") continue;
      const admin = role.permissions.filter((k) => k.startsWith("admin."));
      expect(
        admin,
        `${role.key} holds admin permissions: ${admin.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("keeps DORSI write permissions out of every non-admin role", () => {
    // Officers were granted dorsi.read so the auto-screen can
    // run for them, but tagging a customer as DORSI-related and recording
    // board approval must stay separated from origination.
    for (const role of DEFAULT_ROLES) {
      if (role.key === "ADMIN") continue;
      expect(
        role.permissions,
        `${role.key} can tag DORSI customers`,
      ).not.toContain("dorsi.tag");
      expect(
        role.permissions,
        `${role.key} can self-approve DORSI loans`,
      ).not.toContain("dorsi.board_approve");
    }
  });

  it("does not let a borrower reach staff surfaces", () => {
    const customer = perms("CUSTOMER");
    for (const key of [
      "customers.read",
      "customers.write",
      "loans.read",
      "loans.decide",
      "payments.record",
      "accounting.read",
      "documents.download",
    ]) {
      expect(customer, `CUSTOMER holds ${key}`).not.toContain(key);
    }
  });

  it("separates who may decide a loan from who may disburse it", () => {
    // Not a hard rule for every lender, but the default policy should not
    // hand both halves of the four-eyes control to the accountant.
    const accountant = perms("ACCOUNTANT");
    expect(accountant).not.toContain("loans.decide");
  });
});
