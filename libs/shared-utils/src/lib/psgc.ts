/**
 * Philippine Standard Geographic Code (PSGC) — regions, provinces, and
 * cities/municipalities.
 *
 * The tables live in `psgc.data.ts` and are GENERATED from the PSA's
 * PSGC (see `scripts/generate-psgc.mjs`). They used to be hand-written
 * here, which went about as well as hand-writing reference data ever
 * does: 72 of ~1,640 municipalities, 11 province codes matching
 * nothing, ARMM's retired region code standing in for BARMM's, and a
 * 77-entry barangay list offering a Cebu City resident three choices
 * out of eighty. A borrower whose town was missing couldn't be
 * recorded correctly.
 *
 * ## What's stored
 *
 * Customer rows store the NAME, not the code — `region`, `province`
 * and `city` are plain strings. That's why the generator keeps the
 * short region labels ("Region I", "NCR") rather than the dataset's
 * "Region I (Ilocos Region)": changing them would orphan every
 * existing row and every report that groups by region.
 *
 * Codes are carried for joins within these tables and for a future
 * PSGC integration; nothing outside this module depends on them.
 *
 * ## Barangays
 *
 * Deliberately absent. The full set is ~42,000 entries (~1.3 MB), and
 * a partial one is worse than none: a resident of an omitted barangay
 * reads the dropdown as "your address is invalid". Barangay stays
 * free-text until there's reason to lazy-load the real list.
 */

import {
  PSGC_CITIES_DATA,
  PSGC_PROVINCES_DATA,
  PSGC_REGIONS_DATA,
} from "./psgc.data";

export interface PsgcRegion {
  /** 10-digit PSGC code, e.g. "1300000000" for NCR. */
  code: string;
  /** Short label used in dropdowns and stored on Customer.region. */
  name: string;
  /** Long label shown as a hint, e.g. "National Capital Region". */
  longName?: string;
}

export interface PsgcProvince {
  code: string;
  name: string;
  regionCode: string;
}

export interface PsgcCity {
  code: string;
  name: string;
  /**
   * Province parent, or null when the city has none.
   *
   * Two kinds of city land here, and neither is a gap in the data:
   * every NCR city, and the highly urbanized cities that PSGC holds
   * independent of the province surrounding them — Cebu City, Davao
   * City, Baguio, Iloilo, Zamboanga and a dozen others.
   */
  provinceCode: string | null;
  /** Region parent — denormalised so NCR can filter by region alone. */
  regionCode: string;
  /**
   * Provincial capital. PSGC encodes this by appending "(Capital)" to
   * the name; kept as a flag so the label stays clean and the stored
   * customer value doesn't carry it.
   */
  isCapital?: boolean;
}

/** 17 regions, in the PSA's Luzon → Visayas → Mindanao order. */
export const PSGC_REGIONS: ReadonlyArray<PsgcRegion> = PSGC_REGIONS_DATA;

/** 82 provinces. NCR has none — see `regionHasProvinces`. */
export const PSGC_PROVINCES: ReadonlyArray<PsgcProvince> = PSGC_PROVINCES_DATA;

/** Every city and municipality. */
export const PSGC_CITIES: ReadonlyArray<PsgcCity> = PSGC_CITIES_DATA;

/**
 * Name lookups are the hot path — every render of every address field
 * resolves a region or province by name — so they're indexed rather
 * than scanned. Built on first use, so a bundle importing a helper it
 * never calls pays nothing.
 */
function byName<T extends { name: string }>(rows: ReadonlyArray<T>) {
  let index: Map<string, T> | null = null;
  return (name: string): T | undefined => {
    index ??= new Map(rows.map((r) => [r.name.toLowerCase(), r]));
    return index.get(name.toLowerCase());
  };
}

const findRegion = byName(PSGC_REGIONS);
const findProvince = byName(PSGC_PROVINCES);

function sortByName<T extends { name: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Provinces in a region. Empty for NCR and for an unknown region. */
export function provincesForRegion(regionName: string): PsgcProvince[] {
  const region = findRegion(regionName);
  if (!region) return [];
  return sortByName(PSGC_PROVINCES.filter((p) => p.regionCode === region.code));
}

/**
 * Does this region have provinces to choose from?
 *
 * Only NCR doesn't. Callers use this to skip the province step rather
 * than render an empty dropdown that reads as broken.
 */
export function regionHasProvinces(regionName: string): boolean {
  return provincesForRegion(regionName).length > 0;
}

/** Region by its stored name. */
export function regionForName(name: string): PsgcRegion | undefined {
  return findRegion(name);
}

/**
 * Cities belonging to a province, strictly.
 *
 * Excludes the highly urbanized cities inside that province's
 * geography — Cebu City is not part of Cebu province. Correct, and
 * usually not what an address form wants: see `citiesFor`.
 */
export function citiesForProvince(provinceName: string): PsgcCity[] {
  const province = findProvince(provinceName);
  if (!province) return [];
  return sortByName(
    PSGC_CITIES.filter((c) => c.provinceCode === province.code),
  );
}

/**
 * Every city in a region, across all its provinces.
 *
 * What NCR needs, having no provinces — and also the right answer when
 * someone picks a region and wants to see what's in it before
 * narrowing.
 */
export function citiesForRegion(regionName: string): PsgcCity[] {
  const region = findRegion(regionName);
  if (!region) return [];
  return sortByName(PSGC_CITIES.filter((c) => c.regionCode === region.code));
}

/**
 * The cities to offer for a region/province pair — the question every
 * address form actually asks.
 *
 * A province narrows; without one you get the whole region; with
 * neither, the country. 1,600 entries is a lot for a dropdown but the
 * right answer for a searchable one, and it beats an empty list for
 * someone who knows their city but not its region.
 *
 * Narrowing by province ALSO includes that region's province-less
 * cities. Someone living in Cebu City picks region VII and province
 * Cebu, and would otherwise not find their own city — PSGC holds
 * highly urbanized cities independent of the province around them.
 * Offering them alongside doesn't claim they belong to the province;
 * it just declines to hide a city from the person who lives in it.
 */
export function citiesFor(
  regionName?: string | null,
  provinceName?: string | null,
): PsgcCity[] {
  if (provinceName) {
    const inProvince = citiesForProvince(provinceName);
    if (inProvince.length > 0) {
      const province = findProvince(provinceName);
      const independent = province
        ? PSGC_CITIES.filter(
            (c) =>
              c.provinceCode === null && c.regionCode === province.regionCode,
          )
        : [];
      return sortByName([...inProvince, ...independent]);
    }
  }
  if (regionName) {
    const cities = citiesForRegion(regionName);
    if (cities.length > 0) return cities;
  }
  return sortByName([...PSGC_CITIES]);
}

/**
 * Where a city sits, for back-filling region and province when only
 * the city is known — a bulk import with one address column, say.
 *
 * Returns null when the name is ambiguous. Hundreds of municipality
 * names repeat across provinces (there is more than one San Isidro),
 * and guessing would quietly file a borrower in the wrong province.
 */
export function locateCity(cityName: string): {
  city: PsgcCity;
  province: PsgcProvince | null;
  region: PsgcRegion;
} | null {
  const target = cityName.trim().toLowerCase();
  const matches = PSGC_CITIES.filter((c) => c.name.toLowerCase() === target);
  if (matches.length !== 1) return null;
  const city = matches[0]!;
  const region = PSGC_REGIONS.find((r) => r.code === city.regionCode);
  if (!region) return null;
  return {
    city,
    province: PSGC_PROVINCES.find((p) => p.code === city.provinceCode) ?? null,
    region,
  };
}
