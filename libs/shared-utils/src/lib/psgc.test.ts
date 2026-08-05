import { describe, expect, it } from "vitest";

import {
  PSGC_CITIES,
  PSGC_PROVINCES,
  PSGC_REGIONS,
  citiesFor,
  citiesForProvince,
  citiesForRegion,
  findCity,
  loadBarangaysForCity,
  locateCity,
  provincesForRegion,
  regionForName,
  regionHasProvinces,
} from "./psgc";

describe("dataset shape", () => {
  it("has all 17 regions and 82 provinces", () => {
    expect(PSGC_REGIONS).toHaveLength(17);
    expect(PSGC_PROVINCES).toHaveLength(82);
  });

  it("carries the whole country, not a starter set", () => {
    // The hand-written table this replaced had 72. The guard is a
    // floor rather than an equality so a PSGC refresh that adds a
    // municipality doesn't fail the build.
    expect(PSGC_CITIES.length).toBeGreaterThan(1600);
  });

  it("parents every province and city to something real", () => {
    const regionCodes = new Set(PSGC_REGIONS.map((r) => r.code));
    const provinceCodes = new Set(PSGC_PROVINCES.map((p) => p.code));
    for (const p of PSGC_PROVINCES) {
      expect(regionCodes.has(p.regionCode), p.name).toBe(true);
    }
    for (const c of PSGC_CITIES) {
      expect(regionCodes.has(c.regionCode), c.name).toBe(true);
      if (c.provinceCode !== null) {
        expect(provinceCodes.has(c.provinceCode), c.name).toBe(true);
      }
    }
  });

  it("gives every region at least one city", () => {
    // A region that lists nothing is a join bug — it would strand
    // every borrower who lives there.
    for (const r of PSGC_REGIONS) {
      expect(citiesForRegion(r.name).length, r.name).toBeGreaterThan(0);
    }
  });

  it("gives every province at least one city", () => {
    for (const p of PSGC_PROVINCES) {
      expect(citiesFor(null, p.name).length, p.name).toBeGreaterThan(0);
    }
  });
});

describe("region labels", () => {
  it("keeps the short forms that customer rows already store", () => {
    // The dataset spells these "Region I (Ilocos Region)". Switching
    // to that would orphan every existing Customer.region value.
    expect(regionForName("NCR")?.longName).toBe("National Capital Region");
    expect(regionForName("Region IV-A")?.longName).toBe("CALABARZON");
    expect(regionForName("BARMM")).toBeDefined();
    expect(regionForName("CAR")).toBeDefined();
  });

  it("resolves a name regardless of case", () => {
    expect(regionForName("ncr")?.name).toBe("NCR");
  });

  it("returns undefined rather than guessing at an unknown name", () => {
    expect(regionForName("Region XCIX")).toBeUndefined();
  });
});

describe("the NCR special case", () => {
  it("reports no provinces", () => {
    expect(provincesForRegion("NCR")).toEqual([]);
    expect(regionHasProvinces("NCR")).toBe(false);
  });

  it("still offers its cities, sourced from the region", () => {
    const cities = citiesForRegion("NCR");
    // 16 cities + the municipality of Pateros.
    expect(cities).toHaveLength(17);
    const names = cities.map((c) => c.name);
    expect(names).toContain("City of Manila");
    expect(names).toContain("Quezon City");
    expect(names).toContain("Pateros");
  });

  it("does not list Manila's sub-municipalities as cities", () => {
    // Tondo and Binondo are inside the City of Manila. Listing them
    // beside it would make one address answerable two ways.
    const names = citiesForRegion("NCR").map((c) => c.name);
    expect(names).not.toContain("Binondo");
    expect(names).not.toContain("Tondo I/II");
  });

  it("does not leak the district pseudo-provinces into the city list", () => {
    const names = citiesForRegion("NCR").map((c) => c.name);
    expect(names.some((n) => n.includes("Not a Province"))).toBe(false);
  });
});

describe("every other region has provinces", () => {
  it.each(PSGC_REGIONS.filter((r) => r.name !== "NCR").map((r) => r.name))(
    "%s",
    (name) => {
      expect(regionHasProvinces(name)).toBe(true);
    },
  );
});

describe("citiesFor", () => {
  it("narrows to the province when one is given", () => {
    const cities = citiesFor("Region VII", "Cebu");
    expect(cities.length).toBeGreaterThan(40);
    // Bohol is in the same region but must not appear.
    expect(cities.map((c) => c.name)).not.toContain("City of Tagbilaran");
  });

  it("includes the region's independent cities alongside a province", () => {
    // PSGC holds Cebu City, Lapu-Lapu and Mandaue outside Cebu
    // province. Someone who lives in Cebu City picks province "Cebu"
    // and must still find it.
    const names = citiesFor("Region VII", "Cebu").map((c) => c.name);
    expect(names).toContain("City of Cebu");
    expect(names).toContain("City of Lapu-Lapu");
    expect(names).toContain("City of Mandaue");
    // Strictly, they aren't part of the province.
    expect(citiesForProvince("Cebu").map((c) => c.name)).not.toContain(
      "City of Cebu",
    );
  });

  it("falls back to the region when no province is given", () => {
    const cities = citiesFor("Region VII", null);
    const names = cities.map((c) => c.name);
    expect(names).toContain("City of Cebu");
    expect(names).toContain("City of Tagbilaran");
  });

  it("falls back to the region when the province is unknown", () => {
    // A legacy free-text value shouldn't collapse the list to empty.
    const cities = citiesFor("Region VII", "Not A Province");
    expect(cities.length).toBeGreaterThan(0);
  });

  it("offers the whole country when nothing is known", () => {
    expect(citiesFor(null, null).length).toBe(PSGC_CITIES.length);
  });

  it("sorts by name", () => {
    const names = citiesFor("Region VII", "Cebu").map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("locateCity", () => {
  it("resolves a city that appears exactly once", () => {
    const hit = locateCity("Quezon City");
    expect(hit?.region.name).toBe("NCR");
    expect(hit?.province).toBeNull();
  });

  it("refuses an ambiguous name rather than picking one", () => {
    // Many provinces have a San Isidro. Guessing would file a
    // borrower in the wrong one.
    const dupes = PSGC_CITIES.filter((c) => c.name === "San Isidro");
    expect(dupes.length).toBeGreaterThan(1);
    expect(locateCity("San Isidro")).toBeNull();
  });

  it("returns null for an unknown name", () => {
    expect(locateCity("Springfield")).toBeNull();
  });
});

describe("the Maguindanao split", () => {
  it("lists both halves as provinces", () => {
    const barmm = provincesForRegion("BARMM").map((p) => p.name);
    expect(barmm).toContain("Maguindanao del Norte");
    expect(barmm).toContain("Maguindanao del Sur");
    expect(barmm).not.toContain("Maguindanao");
  });

  it("offers the same municipalities under each half", () => {
    // The source PSGC release predates the 2022 split and carries no
    // municipality-to-half assignment. Rather than invent one, both
    // halves offer the full list — nothing is narrowed, nothing is
    // fabricated, and no borrower is blocked.
    const north = citiesForProvince("Maguindanao del Norte").map((c) => c.name);
    const south = citiesForProvince("Maguindanao del Sur").map((c) => c.name);
    expect(north.length).toBeGreaterThan(0);
    expect(north).toEqual(south);
  });
});

describe("findCity", () => {
  it("resolves a unique name without any scope", () => {
    expect(findCity("Quezon City")?.regionCode).toBe("1300000000");
  });

  it("uses the province to disambiguate a repeated name", () => {
    // Nationally ambiguous, unique inside a province — which is
    // exactly why the barangay picker passes its scope in.
    expect(findCity("San Isidro")).toBeNull();
    expect(findCity("San Isidro", "Region III", "Nueva Ecija")).not.toBeNull();
  });

  it("returns null for a name that isn't a city", () => {
    expect(findCity("Not A Place", "Region VII", "Cebu")).toBeNull();
    expect(findCity("")).toBeNull();
  });

  it("ignores surrounding whitespace and case", () => {
    expect(findCity("  quezon city ")?.name).toBe("Quezon City");
  });
});

describe("loadBarangaysForCity", () => {
  it("loads a city's barangays on demand", async () => {
    const city = findCity("City of Cebu", "Region VII", "Cebu");
    const rows = await loadBarangaysForCity(city);
    expect(rows.length).toBeGreaterThan(70);
    // PSGC marks poblacion barangays: "Lahug (Pob.)", not "Lahug".
    expect(rows).toContain("Lahug (Pob.)");
    expect(rows).toContain("Guadalupe");
  });

  it("covers a city the old hand-written list never reached", () => {
    // Apas is one of the Cebu City barangays the 77-entry table
    // omitted; a resident there had no valid option.
    return expect(
      loadBarangaysForCity(findCity("City of Cebu", "Region VII", "Cebu")),
    ).resolves.toContain("Apas");
  });

  it("resolves to empty rather than throwing for an unknown city", async () => {
    // A legacy free-text city has no list; the field stays usable.
    await expect(loadBarangaysForCity(null)).resolves.toEqual([]);
  });

  it("serves the Maguindanao halves despite their suffixed codes", async () => {
    // Those city codes carry a ":N"/":S" the barangay data knows
    // nothing about, so the lookup has to strip it.
    const city = findCity(
      "Datu Odin Sinsuat",
      "BARMM",
      "Maguindanao del Norte",
    );
    expect(city?.code).toContain(":");
    await expect(loadBarangaysForCity(city)).resolves.not.toEqual([]);
  });

  it("returns the same rows on a repeated call", async () => {
    const city = findCity("Quezon City");
    const a = await loadBarangaysForCity(city);
    const b = await loadBarangaysForCity(city);
    expect(b).toEqual(a);
  });
});
