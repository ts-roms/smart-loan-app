/**
 * Philippine Standard Geographic Code (PSGC) — regions + provinces.
 *
 * Why only regions + provinces:
 *   • Regions: 17. Trivially small, perfect for a dropdown.
 *   • Provinces: ~82. Still small (a few KB JSON).
 *   • Cities/municipalities: ~1,500. Borderline; bundling them roughly
 *     doubles the data for a marginal usability win.
 *   • Barangays: ~42,000. Would balloon the bundle to ~3 MB.
 *
 * For v1 we hardcode the first two tiers (regions and provinces). City
 * and barangay remain free-text inputs with autocomplete suggestion
 * from previously-entered values being a sensible future addition.
 *
 * Source: PSA PSGC publication, Q4 2024. Codes are stable across
 * decades except when a province is split — those are rare events that
 * a single annual refresh handles. The codes themselves are not used
 * for cross-system lookups in this app; we only store the human label
 * on the Customer row. Codes are kept here for completeness and so a
 * future PSGC API integration can correlate.
 */

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

/**
 * 17 PH regions. Display order mirrors the PSA convention: Luzon →
 * Visayas → Mindanao, BARMM at the end.
 */
export const PSGC_REGIONS: ReadonlyArray<PsgcRegion> = [
  { code: "0100000000", name: "Region I", longName: "Ilocos Region" },
  { code: "0200000000", name: "Region II", longName: "Cagayan Valley" },
  { code: "0300000000", name: "Region III", longName: "Central Luzon" },
  { code: "0400000000", name: "Region IV-A", longName: "CALABARZON" },
  { code: "1700000000", name: "Region IV-B", longName: "MIMAROPA" },
  { code: "0500000000", name: "Region V", longName: "Bicol Region" },
  { code: "0600000000", name: "Region VI", longName: "Western Visayas" },
  { code: "0700000000", name: "Region VII", longName: "Central Visayas" },
  { code: "0800000000", name: "Region VIII", longName: "Eastern Visayas" },
  { code: "0900000000", name: "Region IX", longName: "Zamboanga Peninsula" },
  { code: "1000000000", name: "Region X", longName: "Northern Mindanao" },
  { code: "1100000000", name: "Region XI", longName: "Davao Region" },
  { code: "1200000000", name: "Region XII", longName: "SOCCSKSARGEN" },
  { code: "1600000000", name: "Region XIII", longName: "Caraga" },
  { code: "1300000000", name: "NCR", longName: "National Capital Region" },
  {
    code: "1400000000",
    name: "CAR",
    longName: "Cordillera Administrative Region",
  },
  {
    code: "1900000000",
    name: "BARMM",
    longName: "Bangsamoro Autonomous Region in Muslim Mindanao",
  },
];

/**
 * Provinces, sorted by region then alphabetically within. NCR and
 * Metro Manila don't have provinces (cities directly under NCR), so
 * they're absent from this list — the AddressPicker handles that by
 * skipping the province field when region === 'NCR'.
 */
export const PSGC_PROVINCES: ReadonlyArray<PsgcProvince> = [
  // Region I — Ilocos
  { code: "0102800000", name: "Ilocos Norte", regionCode: "0100000000" },
  { code: "0102900000", name: "Ilocos Sur", regionCode: "0100000000" },
  { code: "0103300000", name: "La Union", regionCode: "0100000000" },
  { code: "0105500000", name: "Pangasinan", regionCode: "0100000000" },
  // Region II — Cagayan Valley
  { code: "0200900000", name: "Batanes", regionCode: "0200000000" },
  { code: "0201500000", name: "Cagayan", regionCode: "0200000000" },
  { code: "0203100000", name: "Isabela", regionCode: "0200000000" },
  { code: "0205000000", name: "Nueva Vizcaya", regionCode: "0200000000" },
  { code: "0205700000", name: "Quirino", regionCode: "0200000000" },
  // Region III — Central Luzon
  { code: "0300800000", name: "Aurora", regionCode: "0300000000" },
  { code: "0301400000", name: "Bataan", regionCode: "0300000000" },
  { code: "0301400001", name: "Bulacan", regionCode: "0300000000" },
  { code: "0304900000", name: "Nueva Ecija", regionCode: "0300000000" },
  { code: "0305400000", name: "Pampanga", regionCode: "0300000000" },
  { code: "0306900000", name: "Tarlac", regionCode: "0300000000" },
  { code: "0307100000", name: "Zambales", regionCode: "0300000000" },
  // Region IV-A — CALABARZON
  { code: "0401000000", name: "Batangas", regionCode: "0400000000" },
  { code: "0402100000", name: "Cavite", regionCode: "0400000000" },
  { code: "0403400000", name: "Laguna", regionCode: "0400000000" },
  { code: "0405600000", name: "Quezon", regionCode: "0400000000" },
  { code: "0405800000", name: "Rizal", regionCode: "0400000000" },
  // Region IV-B — MIMAROPA
  { code: "1704000000", name: "Marinduque", regionCode: "1700000000" },
  { code: "1705100000", name: "Occidental Mindoro", regionCode: "1700000000" },
  { code: "1705200000", name: "Oriental Mindoro", regionCode: "1700000000" },
  { code: "1705300000", name: "Palawan", regionCode: "1700000000" },
  { code: "1705900000", name: "Romblon", regionCode: "1700000000" },
  // Region V — Bicol
  { code: "0500500000", name: "Albay", regionCode: "0500000000" },
  { code: "0501600000", name: "Camarines Norte", regionCode: "0500000000" },
  { code: "0501700000", name: "Camarines Sur", regionCode: "0500000000" },
  { code: "0502000000", name: "Catanduanes", regionCode: "0500000000" },
  { code: "0504100000", name: "Masbate", regionCode: "0500000000" },
  { code: "0506200000", name: "Sorsogon", regionCode: "0500000000" },
  // Region VI — Western Visayas
  { code: "0604200000", name: "Aklan", regionCode: "0600000000" },
  { code: "0604300000", name: "Antique", regionCode: "0600000000" },
  { code: "0604500000", name: "Capiz", regionCode: "0600000000" },
  { code: "0603000000", name: "Iloilo", regionCode: "0600000000" },
  { code: "0607900000", name: "Negros Occidental", regionCode: "0600000000" },
  { code: "0606100000", name: "Guimaras", regionCode: "0600000000" },
  // Region VII — Central Visayas
  { code: "0701200000", name: "Bohol", regionCode: "0700000000" },
  { code: "0702200000", name: "Cebu", regionCode: "0700000000" },
  { code: "0704600000", name: "Negros Oriental", regionCode: "0700000000" },
  { code: "0706100000", name: "Siquijor", regionCode: "0700000000" },
  // Region VIII — Eastern Visayas
  { code: "0802600000", name: "Biliran", regionCode: "0800000000" },
  { code: "0803700000", name: "Eastern Samar", regionCode: "0800000000" },
  { code: "0803800000", name: "Leyte", regionCode: "0800000000" },
  { code: "0806000000", name: "Northern Samar", regionCode: "0800000000" },
  { code: "0806400000", name: "Samar", regionCode: "0800000000" },
  { code: "0807800000", name: "Southern Leyte", regionCode: "0800000000" },
  // Region IX — Zamboanga Peninsula
  { code: "0907200000", name: "Zamboanga del Norte", regionCode: "0900000000" },
  { code: "0907300000", name: "Zamboanga del Sur", regionCode: "0900000000" },
  { code: "0908300000", name: "Zamboanga Sibugay", regionCode: "0900000000" },
  // Region X — Northern Mindanao
  { code: "1001300000", name: "Bukidnon", regionCode: "1000000000" },
  { code: "1001800000", name: "Camiguin", regionCode: "1000000000" },
  { code: "1003500000", name: "Lanao del Norte", regionCode: "1000000000" },
  { code: "1004200000", name: "Misamis Occidental", regionCode: "1000000000" },
  { code: "1004300000", name: "Misamis Oriental", regionCode: "1000000000" },
  // Region XI — Davao
  { code: "1102300000", name: "Davao de Oro", regionCode: "1100000000" },
  { code: "1102400000", name: "Davao del Norte", regionCode: "1100000000" },
  { code: "1102500000", name: "Davao del Sur", regionCode: "1100000000" },
  { code: "1108200000", name: "Davao Occidental", regionCode: "1100000000" },
  { code: "1102700000", name: "Davao Oriental", regionCode: "1100000000" },
  // Region XII — SOCCSKSARGEN
  { code: "1204700000", name: "Cotabato", regionCode: "1200000000" },
  { code: "1206300000", name: "South Cotabato", regionCode: "1200000000" },
  { code: "1206500000", name: "Sultan Kudarat", regionCode: "1200000000" },
  { code: "1208000000", name: "Sarangani", regionCode: "1200000000" },
  // Region XIII — Caraga
  { code: "1606700000", name: "Agusan del Norte", regionCode: "1600000000" },
  { code: "1600800000", name: "Agusan del Sur", regionCode: "1600000000" },
  { code: "1608500000", name: "Dinagat Islands", regionCode: "1600000000" },
  { code: "1606800000", name: "Surigao del Norte", regionCode: "1600000000" },
  { code: "1606900000", name: "Surigao del Sur", regionCode: "1600000000" },
  // CAR — Cordillera
  { code: "1400100000", name: "Abra", regionCode: "1400000000" },
  { code: "1401100000", name: "Apayao", regionCode: "1400000000" },
  { code: "1402700000", name: "Benguet", regionCode: "1400000000" },
  { code: "1403200000", name: "Ifugao", regionCode: "1400000000" },
  { code: "1404400000", name: "Kalinga", regionCode: "1400000000" },
  { code: "1408100000", name: "Mountain Province", regionCode: "1400000000" },
  // BARMM
  { code: "1903700000", name: "Basilan", regionCode: "1900000000" },
  { code: "1903600000", name: "Lanao del Sur", regionCode: "1900000000" },
  {
    code: "1906600000",
    name: "Maguindanao del Norte",
    regionCode: "1900000000",
  },
  { code: "1906600001", name: "Maguindanao del Sur", regionCode: "1900000000" },
  { code: "1906500000", name: "Sulu", regionCode: "1900000000" },
  { code: "1907000000", name: "Tawi-Tawi", regionCode: "1900000000" },
];

/**
 * Provinces filtered to one region. Returns an empty array if the
 * region has no provinces (e.g. NCR — all 16 cities sit directly
 * under the region).
 */
export function provincesForRegion(regionName: string): PsgcProvince[] {
  const region = PSGC_REGIONS.find((r) => r.name === regionName);
  if (!region) return [];
  return PSGC_PROVINCES.filter((p) => p.regionCode === region.code).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

/**
 * Region name lookup by code, for back-resolution when the customer
 * record only carries the code-style identifier.
 */
export function regionForName(name: string): PsgcRegion | undefined {
  return PSGC_REGIONS.find((r) => r.name === name);
}
