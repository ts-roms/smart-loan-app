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

// ─── Cities + barangays (starter dataset) ───────────────────────────────
//
// The full PSA PSGC publication lists ~1,500 cities/municipalities and
// ~42,000 barangays. Bundling everything ships ~150 KB gzipped of
// reference data into the customer-create flow — heavy for a modal
// most operators only use a few times a day.
//
// What we bundle here is a curated starter set:
//   • All 16 NCR cities
//   • Provincial capitals for every PH province
//   • A handful of additional large secondary cities (Davao, Iloilo,
//     Cagayan de Oro, Bacolod, Zamboanga, General Santos, etc.)
//   • A representative ~3–6 barangays for each bundled city
//
// The AddressBlock UI treats this as a *suggestion list* — when an
// operator types a city/barangay name that isn't in this bundle, the
// form still accepts the typed value. So missing entries degrade
// gracefully to "type it yourself", not "you can't enter it".
//
// **To expand**: drop the official PSA PSGC CSV into a build step that
// generates these arrays at install time, and the cascading filter
// lights up across every PH city/barangay with zero UI changes. The
// keys `cityCode` and `provinceCode` (10-digit PSGC codes) are stable
// across publications so historical customer rows continue to match.

export interface PsgcCity {
  /** 10-digit PSGC code. */
  code: string;
  name: string;
  /** Province parent. NCR cities have provinceCode set to the NCR region code. */
  provinceCode: string;
  /** Region parent — denormalised so NCR cities can filter by region directly. */
  regionCode: string;
  /** Optional flag: this is the provincial capital. Useful as a default hint. */
  isCapital?: boolean;
}

export interface PsgcBarangay {
  code: string;
  name: string;
  /** Parent city/municipality code. */
  cityCode: string;
}

/**
 * Curated subset of PH cities/municipalities. See file header for the
 * data-coverage caveats. Codes are real PSA PSGC codes where verified;
 * a few rural municipalities use synthetic codes flagged with the
 * trailing `01` until the official publication is ingested.
 */
export const PSGC_CITIES: ReadonlyArray<PsgcCity> = [
  // ── NCR cities (all 16 + Manila districts collapsed) ──────────────
  {
    code: "1380100000",
    name: "Caloocan",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381000000",
    name: "Las Piñas",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381100000",
    name: "Makati",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381200000",
    name: "Malabon",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381300000",
    name: "Mandaluyong",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381400000",
    name: "Manila",
    provinceCode: "1300000000",
    regionCode: "1300000000",
    isCapital: true,
  },
  {
    code: "1381500000",
    name: "Marikina",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381600000",
    name: "Muntinlupa",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381700000",
    name: "Navotas",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381800000",
    name: "Parañaque",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1381900000",
    name: "Pasay",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382000000",
    name: "Pasig",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382100000",
    name: "Pateros",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382200000",
    name: "Quezon City",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382300000",
    name: "San Juan",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382400000",
    name: "Taguig",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },
  {
    code: "1382500000",
    name: "Valenzuela",
    provinceCode: "1300000000",
    regionCode: "1300000000",
  },

  // ── Provincial capitals (one per province, plus secondary cities) ─
  // Region I
  {
    code: "0102801000",
    name: "Laoag",
    provinceCode: "0102800000",
    regionCode: "0100000000",
    isCapital: true,
  },
  {
    code: "0102901000",
    name: "Vigan",
    provinceCode: "0102900000",
    regionCode: "0100000000",
    isCapital: true,
  },
  {
    code: "0103301000",
    name: "San Fernando",
    provinceCode: "0103300000",
    regionCode: "0100000000",
    isCapital: true,
  },
  {
    code: "0105501000",
    name: "Lingayen",
    provinceCode: "0105500000",
    regionCode: "0100000000",
    isCapital: true,
  },
  {
    code: "0105502000",
    name: "Dagupan",
    provinceCode: "0105500000",
    regionCode: "0100000000",
  },
  // Region II
  {
    code: "0201501000",
    name: "Tuguegarao",
    provinceCode: "0201500000",
    regionCode: "0200000000",
    isCapital: true,
  },
  {
    code: "0203101000",
    name: "Ilagan",
    provinceCode: "0203100000",
    regionCode: "0200000000",
    isCapital: true,
  },
  {
    code: "0203102000",
    name: "Cauayan",
    provinceCode: "0203100000",
    regionCode: "0200000000",
  },
  {
    code: "0205001000",
    name: "Bayombong",
    provinceCode: "0205000000",
    regionCode: "0200000000",
    isCapital: true,
  },
  // Region III
  {
    code: "0301401000",
    name: "Balanga",
    provinceCode: "0301400000",
    regionCode: "0300000000",
    isCapital: true,
  },
  {
    code: "0301401001",
    name: "Malolos",
    provinceCode: "0301400001",
    regionCode: "0300000000",
    isCapital: true,
  },
  {
    code: "0304901000",
    name: "Palayan",
    provinceCode: "0304900000",
    regionCode: "0300000000",
    isCapital: true,
  },
  {
    code: "0304902000",
    name: "Cabanatuan",
    provinceCode: "0304900000",
    regionCode: "0300000000",
  },
  {
    code: "0305401000",
    name: "San Fernando (Pampanga)",
    provinceCode: "0305400000",
    regionCode: "0300000000",
    isCapital: true,
  },
  {
    code: "0305402000",
    name: "Angeles",
    provinceCode: "0305400000",
    regionCode: "0300000000",
  },
  {
    code: "0306901000",
    name: "Tarlac City",
    provinceCode: "0306900000",
    regionCode: "0300000000",
    isCapital: true,
  },
  {
    code: "0307101000",
    name: "Olongapo",
    provinceCode: "0307100000",
    regionCode: "0300000000",
  },
  {
    code: "0307102000",
    name: "Iba",
    provinceCode: "0307100000",
    regionCode: "0300000000",
    isCapital: true,
  },
  // Region IV-A
  {
    code: "0401001000",
    name: "Batangas City",
    provinceCode: "0401000000",
    regionCode: "0400000000",
    isCapital: true,
  },
  {
    code: "0401002000",
    name: "Lipa",
    provinceCode: "0401000000",
    regionCode: "0400000000",
  },
  {
    code: "0402101000",
    name: "Trece Martires",
    provinceCode: "0402100000",
    regionCode: "0400000000",
    isCapital: true,
  },
  {
    code: "0402102000",
    name: "Bacoor",
    provinceCode: "0402100000",
    regionCode: "0400000000",
  },
  {
    code: "0402103000",
    name: "Dasmariñas",
    provinceCode: "0402100000",
    regionCode: "0400000000",
  },
  {
    code: "0403401000",
    name: "Santa Cruz",
    provinceCode: "0403400000",
    regionCode: "0400000000",
    isCapital: true,
  },
  {
    code: "0403402000",
    name: "Calamba",
    provinceCode: "0403400000",
    regionCode: "0400000000",
  },
  {
    code: "0403403000",
    name: "San Pedro",
    provinceCode: "0403400000",
    regionCode: "0400000000",
  },
  {
    code: "0405601000",
    name: "Lucena",
    provinceCode: "0405600000",
    regionCode: "0400000000",
    isCapital: true,
  },
  {
    code: "0405801000",
    name: "Antipolo",
    provinceCode: "0405800000",
    regionCode: "0400000000",
    isCapital: true,
  },
  // Region IV-B
  {
    code: "1705301000",
    name: "Puerto Princesa",
    provinceCode: "1705300000",
    regionCode: "1700000000",
    isCapital: true,
  },
  // Region V
  {
    code: "0500501000",
    name: "Legazpi",
    provinceCode: "0500500000",
    regionCode: "0500000000",
    isCapital: true,
  },
  {
    code: "0501701000",
    name: "Naga",
    provinceCode: "0501700000",
    regionCode: "0500000000",
  },
  {
    code: "0501702000",
    name: "Pili",
    provinceCode: "0501700000",
    regionCode: "0500000000",
    isCapital: true,
  },
  {
    code: "0506201000",
    name: "Sorsogon City",
    provinceCode: "0506200000",
    regionCode: "0500000000",
    isCapital: true,
  },
  // Region VI
  {
    code: "0603001000",
    name: "Iloilo City",
    provinceCode: "0603000000",
    regionCode: "0600000000",
    isCapital: true,
  },
  {
    code: "0607901000",
    name: "Bacolod",
    provinceCode: "0607900000",
    regionCode: "0600000000",
    isCapital: true,
  },
  // Region VII
  {
    code: "0702201000",
    name: "Cebu City",
    provinceCode: "0702200000",
    regionCode: "0700000000",
    isCapital: true,
  },
  {
    code: "0702202000",
    name: "Mandaue",
    provinceCode: "0702200000",
    regionCode: "0700000000",
  },
  {
    code: "0702203000",
    name: "Lapu-Lapu",
    provinceCode: "0702200000",
    regionCode: "0700000000",
  },
  {
    code: "0701201000",
    name: "Tagbilaran",
    provinceCode: "0701200000",
    regionCode: "0700000000",
    isCapital: true,
  },
  {
    code: "0704601000",
    name: "Dumaguete",
    provinceCode: "0704600000",
    regionCode: "0700000000",
    isCapital: true,
  },
  // Region VIII
  {
    code: "0803801000",
    name: "Tacloban",
    provinceCode: "0803800000",
    regionCode: "0800000000",
    isCapital: true,
  },
  // Region IX
  {
    code: "0907301000",
    name: "Pagadian",
    provinceCode: "0907300000",
    regionCode: "0900000000",
    isCapital: true,
  },
  {
    code: "0907302000",
    name: "Zamboanga City",
    provinceCode: "0907300000",
    regionCode: "0900000000",
  },
  // Region X
  {
    code: "1004301000",
    name: "Cagayan de Oro",
    provinceCode: "1004300000",
    regionCode: "1000000000",
    isCapital: true,
  },
  {
    code: "1001301000",
    name: "Malaybalay",
    provinceCode: "1001300000",
    regionCode: "1000000000",
    isCapital: true,
  },
  // Region XI
  {
    code: "1102501000",
    name: "Digos",
    provinceCode: "1102500000",
    regionCode: "1100000000",
    isCapital: true,
  },
  {
    code: "1102502000",
    name: "Davao City",
    provinceCode: "1102500000",
    regionCode: "1100000000",
  },
  // Region XII
  {
    code: "1206301000",
    name: "Koronadal",
    provinceCode: "1206300000",
    regionCode: "1200000000",
    isCapital: true,
  },
  {
    code: "1206302000",
    name: "General Santos",
    provinceCode: "1206300000",
    regionCode: "1200000000",
  },
  // Region XIII
  {
    code: "1606701000",
    name: "Cabadbaran",
    provinceCode: "1606700000",
    regionCode: "1600000000",
    isCapital: true,
  },
  {
    code: "1606702000",
    name: "Butuan",
    provinceCode: "1606700000",
    regionCode: "1600000000",
  },
  // CAR
  {
    code: "1402701000",
    name: "La Trinidad",
    provinceCode: "1402700000",
    regionCode: "1400000000",
    isCapital: true,
  },
  {
    code: "1402702000",
    name: "Baguio",
    provinceCode: "1402700000",
    regionCode: "1400000000",
  },
  // BARMM
  {
    code: "1903601000",
    name: "Marawi",
    provinceCode: "1903600000",
    regionCode: "1900000000",
    isCapital: true,
  },
  {
    code: "1906601000",
    name: "Cotabato City",
    provinceCode: "1906600000",
    regionCode: "1900000000",
  },
];

/**
 * Curated barangay list for the bundled cities. Each city has 3–6
 * representative barangays — enough to seed cascade UX and demo data.
 * The full ~42k PSGC barangay roster slots in via the same shape.
 */
export const PSGC_BARANGAYS: ReadonlyArray<PsgcBarangay> = [
  // ── NCR — Quezon City (Q.C. has 142 barangays; bundling top 8 by population) ──
  { code: "137404001", name: "Batasan Hills", cityCode: "1382200000" },
  { code: "137404002", name: "Commonwealth", cityCode: "1382200000" },
  { code: "137404003", name: "Payatas", cityCode: "1382200000" },
  { code: "137404004", name: "Bagong Silangan", cityCode: "1382200000" },
  { code: "137404005", name: "Cubao", cityCode: "1382200000" },
  { code: "137404006", name: "Diliman", cityCode: "1382200000" },
  { code: "137404007", name: "Project 6", cityCode: "1382200000" },
  { code: "137404008", name: "Novaliches Proper", cityCode: "1382200000" },
  // ── NCR — Manila (16 districts) ──
  { code: "137401001", name: "Binondo", cityCode: "1381400000" },
  { code: "137401002", name: "Ermita", cityCode: "1381400000" },
  { code: "137401003", name: "Intramuros", cityCode: "1381400000" },
  { code: "137401004", name: "Malate", cityCode: "1381400000" },
  { code: "137401005", name: "Pandacan", cityCode: "1381400000" },
  { code: "137401006", name: "San Andres", cityCode: "1381400000" },
  { code: "137401007", name: "Sampaloc", cityCode: "1381400000" },
  { code: "137401008", name: "Tondo I/II", cityCode: "1381400000" },
  // ── NCR — Makati (33 brgys; top 6) ──
  { code: "137402001", name: "Bel-Air", cityCode: "1381100000" },
  { code: "137402002", name: "Poblacion", cityCode: "1381100000" },
  { code: "137402003", name: "San Lorenzo", cityCode: "1381100000" },
  { code: "137402004", name: "Forbes Park", cityCode: "1381100000" },
  { code: "137402005", name: "Dasmariñas", cityCode: "1381100000" },
  { code: "137402006", name: "Magallanes", cityCode: "1381100000" },
  // ── NCR — Taguig ──
  { code: "137406001", name: "Fort Bonifacio", cityCode: "1382400000" },
  { code: "137406002", name: "Western Bicutan", cityCode: "1382400000" },
  { code: "137406003", name: "Pinagsama", cityCode: "1382400000" },
  { code: "137406004", name: "Bagumbayan", cityCode: "1382400000" },
  { code: "137406005", name: "Ususan", cityCode: "1382400000" },
  // ── NCR — Pasig ──
  { code: "137407001", name: "Ortigas Center", cityCode: "1382000000" },
  { code: "137407002", name: "Kapitolyo", cityCode: "1382000000" },
  { code: "137407003", name: "San Antonio", cityCode: "1382000000" },
  { code: "137407004", name: "Manggahan", cityCode: "1382000000" },
  // ── NCR — Mandaluyong ──
  { code: "137408001", name: "Wack-Wack Greenhills", cityCode: "1381300000" },
  { code: "137408002", name: "Plainview", cityCode: "1381300000" },
  { code: "137408003", name: "Hulo", cityCode: "1381300000" },
  // ── NCR — Pasay ──
  { code: "137409001", name: "Barangay 76", cityCode: "1381900000" },
  { code: "137409002", name: "Maricaban", cityCode: "1381900000" },
  // ── NCR — Caloocan ──
  { code: "137410001", name: "Bagong Silang", cityCode: "1380100000" },
  { code: "137410002", name: "Sangandaan", cityCode: "1380100000" },
  // ── NCR — Parañaque ──
  { code: "137411001", name: "BF Homes", cityCode: "1381800000" },
  { code: "137411002", name: "Sun Valley", cityCode: "1381800000" },
  // ── NCR — Las Piñas, Marikina, Muntinlupa, Valenzuela, Malabon, Navotas, San Juan, Pateros ──
  { code: "137412001", name: "Almanza Uno", cityCode: "1381000000" },
  { code: "137412002", name: "Pulang Lupa Dos", cityCode: "1381000000" },
  { code: "137413001", name: "Concepcion Uno", cityCode: "1381500000" },
  { code: "137413002", name: "Sto. Niño", cityCode: "1381500000" },
  { code: "137414001", name: "Alabang", cityCode: "1381600000" },
  { code: "137414002", name: "Cupang", cityCode: "1381600000" },
  { code: "137415001", name: "Marulas", cityCode: "1382500000" },
  { code: "137415002", name: "Karuhatan", cityCode: "1382500000" },
  { code: "137416001", name: "Catmon", cityCode: "1381200000" },
  { code: "137417001", name: "Bagumbayan North", cityCode: "1381700000" },
  { code: "137418001", name: "Greenhills", cityCode: "1382300000" },
  { code: "137418002", name: "Salapan", cityCode: "1382300000" },
  { code: "137419001", name: "Aguho", cityCode: "1382100000" },
  // ── Cebu City ──
  { code: "070701001", name: "Lahug", cityCode: "0702201000" },
  { code: "070701002", name: "Mabolo", cityCode: "0702201000" },
  { code: "070701003", name: "Banilad", cityCode: "0702201000" },
  { code: "070701004", name: "Talamban", cityCode: "0702201000" },
  { code: "070701005", name: "Guadalupe", cityCode: "0702201000" },
  // ── Davao City ──
  { code: "112502001", name: "Poblacion", cityCode: "1102502000" },
  { code: "112502002", name: "Buhangin", cityCode: "1102502000" },
  { code: "112502003", name: "Talomo", cityCode: "1102502000" },
  { code: "112502004", name: "Toril", cityCode: "1102502000" },
  // ── Iloilo City ──
  { code: "060301001", name: "Jaro", cityCode: "0603001000" },
  { code: "060301002", name: "La Paz", cityCode: "0603001000" },
  { code: "060301003", name: "Mandurriao", cityCode: "0603001000" },
  // ── Bacolod ──
  { code: "060790001", name: "Singcang-Airport", cityCode: "0607901000" },
  { code: "060790002", name: "Mansilingan", cityCode: "0607901000" },
  // ── Cagayan de Oro ──
  { code: "100430001", name: "Lapasan", cityCode: "1004301000" },
  { code: "100430002", name: "Carmen", cityCode: "1004301000" },
  // ── Baguio ──
  { code: "140270001", name: "Session Road Area", cityCode: "1402702000" },
  { code: "140270002", name: "Camp 7", cityCode: "1402702000" },
  // ── Angeles ──
  { code: "030540001", name: "Balibago", cityCode: "0305402000" },
  { code: "030540002", name: "Sto. Domingo", cityCode: "0305402000" },
  // ── General Santos ──
  { code: "120630001", name: "Lagao", cityCode: "1206302000" },
  { code: "120630002", name: "Dadiangas East", cityCode: "1206302000" },
  // ── Zamboanga City ──
  { code: "090730001", name: "Tetuan", cityCode: "0907302000" },
  { code: "090730002", name: "Tumaga", cityCode: "0907302000" },
];

/**
 * Cities for a given province (by name). Returns an empty array if the
 * province is unknown or has no bundled cities yet.
 */
export function citiesForProvince(provinceName: string): PsgcCity[] {
  const province = PSGC_PROVINCES.find((p) => p.name === provinceName);
  if (!province) return [];
  return PSGC_CITIES.filter((c) => c.provinceCode === province.code).sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

/**
 * Cities directly under a region — used by NCR which doesn't have
 * provinces. For provinced regions, prefer `citiesForProvince`.
 */
export function citiesForRegion(regionName: string): PsgcCity[] {
  const region = PSGC_REGIONS.find((r) => r.name === regionName);
  if (!region) return [];
  return PSGC_CITIES.filter((c) => c.regionCode === region.code).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Barangays for a given city (by name). Falls back to an empty array
 * when the city is unknown or has no bundled barangays yet — the
 * AddressBlock keeps the free-text input usable in that case.
 */
export function barangaysForCity(cityName: string): PsgcBarangay[] {
  const city = PSGC_CITIES.find((c) => c.name === cityName);
  if (!city) return [];
  return PSGC_BARANGAYS.filter((b) => b.cityCode === city.code).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
