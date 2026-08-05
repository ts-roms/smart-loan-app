/**
 * Regenerates `src/lib/psgc.data.ts` from the `ph-geo-admin-divisions`
 * package (PSGC, ISC-licensed).
 *
 * Run with the package installed:
 *   npm i --no-save ph-geo-admin-divisions
 *   node libs/shared-utils/scripts/generate-psgc.mjs
 *
 * The data is COMMITTED rather than imported at runtime. Three reasons:
 * the package ships a 6.4 MB barangay file from a CommonJS index that
 * doesn't tree-shake, we need only three of its four tiers, and a
 * lending app shouldn't take a runtime dependency on a small package
 * for data that changes once a year.
 *
 * Deep-imports each tier for the same reason — pulling the index here
 * would load barangays into memory for nothing.
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Emitting source files means writing newlines into strings a lot. */
const NEWLINE = String.fromCharCode(10);

const require = createRequire(import.meta.url);
const base = "ph-geo-admin-divisions/lib/";
const { regions } = require(base + "regions");
const { provinces } = require(base + "provinces");
const { municipalities } = require(base + "combined-municipalities");
const { baranggays } = require(base + "baranggays");

/**
 * Short region labels. NOT taken from the dataset: these are the
 * values already stored in Customer.region, and the dataset's
 * "Region I (Ilocos Region)" form would orphan every existing row.
 * Keyed by the dataset's two-digit regionId.
 */
const REGION_LABELS = {
  "01": ["Region I", "Ilocos Region"],
  "02": ["Region II", "Cagayan Valley"],
  "03": ["Region III", "Central Luzon"],
  "04": ["Region IV-A", "CALABARZON"],
  "17": ["Region IV-B", "MIMAROPA"],
  "05": ["Region V", "Bicol Region"],
  "06": ["Region VI", "Western Visayas"],
  "07": ["Region VII", "Central Visayas"],
  "08": ["Region VIII", "Eastern Visayas"],
  "09": ["Region IX", "Zamboanga Peninsula"],
  10: ["Region X", "Northern Mindanao"],
  11: ["Region XI", "Davao Region"],
  12: ["Region XII", "SOCCSKSARGEN"],
  16: ["Region XIII", "Caraga"],
  13: ["NCR", "National Capital Region"],
  14: ["CAR", "Cordillera Administrative Region"],
  19: ["BARMM", "Bangsamoro Autonomous Region in Muslim Mindanao"],
};

/** Display order: Luzon → Visayas → Mindanao, special regions last. */
const REGION_ORDER = [
  "01", "02", "03", "04", "17", "05", "06", "07", "08",
  "09", "10", "11", "12", "16", "13", "14", "19",
];

/**
 * Maguindanao was split into del Norte and del Sur by plebiscite in
 * 2022; this dataset still carries the undivided province. The
 * municipality-to-half assignment isn't in any source here, so rather
 * than guess it, both halves are listed and BOTH offer the full
 * Maguindanao municipality list. That never blocks a borrower from
 * finding their town, and it invents nothing — it just doesn't narrow
 * the list. Replace when a PSGC release carries the split.
 */
const MAGUINDANAO_ID = provinces.find((p) => p.name === "Maguindanao")
  ?.provinceId;
const SPLIT_PROVINCES = [
  { name: "Maguindanao del Norte", sourceId: MAGUINDANAO_ID },
  { name: "Maguindanao del Sur", sourceId: MAGUINDANAO_ID },
];

const regionRows = REGION_ORDER.map((id) => {
  const row = regions.find((r) => r.regionId === id);
  if (!row) throw new Error(`region ${id} missing from dataset`);
  const [name, longName] = REGION_LABELS[id];
  return { code: row.psgcId, name, longName, regionId: id };
});

const provinceRows = [];
for (const p of provinces) {
  // NCR appears in the provinces array as a `Reg`-level pseudo-entry.
  // It has no provinces; its cities hang off the region directly.
  if (p.geoLevel !== "Prov") continue;
  if (p.name === "Maguindanao") continue; // replaced by the split below
  provinceRows.push({
    code: p.psgcId,
    name: p.name,
    regionCode: regionRows.find((r) => r.regionId === p.regionId).code,
    sourceId: p.provinceId,
    regionId: p.regionId,
  });
}
for (const split of SPLIT_PROVINCES) {
  const src = provinces.find((p) => p.provinceId === split.sourceId);
  provinceRows.push({
    code: `${src.psgcId}:${split.name.endsWith("Norte") ? "N" : "S"}`,
    name: split.name,
    regionCode: regionRows.find((r) => r.regionId === src.regionId).code,
    sourceId: split.sourceId,
    regionId: src.regionId,
  });
}
provinceRows.sort((a, b) => a.name.localeCompare(b.name));

/**
 * `Dist` rows are NCR's district pseudo-provinces sitting in the
 * municipality array (they carry no psgcId). `SubMun` rows are
 * Manila's 14 sub-municipalities — Tondo, Binondo and the rest are
 * inside the City of Manila, not beside it, and listing them would
 * make one address answerable two ways. `SGU` rows are the BARMM
 * special geographic area's cluster LGUs and DO belong: people live
 * there and nothing else would represent them.
 */
const CITY_LEVELS = new Set(["Mun", "City", "SGU"]);

/**
 * PSGC appends "(Capital)" to a province's capital. That's a fact
 * about the city, not part of its name — "City of Cebu (Capital)" in
 * a dropdown is noise, and it would be stored on the customer row
 * verbatim. Split into a flag.
 */
function splitCapital(name) {
  const m = /^(.*?)\s*\(Capital\)$/.exec(name);
  return m ? { name: m[1].trim(), isCapital: true } : { name, isCapital: false };
}

const cityRows = [];
for (const m of municipalities) {
  if (!CITY_LEVELS.has(m.geoLevel) || !m.psgcId) continue;
  const { name: cityName, isCapital } = splitCapital(m.name);
  const region = regionRows.find((r) => r.regionId === m.regionId);
  if (!region) continue;
  const parents = provinceRows.filter(
    (p) => p.regionId === m.regionId && p.sourceId === m.provinceId,
  );
  if (parents.length === 0) {
    // NCR: cities sit under the region with no province of their own.
    cityRows.push({
      code: m.psgcId,
      name: cityName,
      isCapital,
      provinceCode: null,
      regionCode: region.code,
    });
    continue;
  }
  for (const parent of parents) {
    cityRows.push({
      code: parents.length > 1 ? `${m.psgcId}:${parent.code.slice(-1)}` : m.psgcId,
      name: cityName,
      isCapital,
      provinceCode: parent.code,
      regionCode: region.code,
    });
  }
}
cityRows.sort((a, b) => a.name.localeCompare(b.name));

const lit = (v) => (v === null ? "null" : JSON.stringify(v));
const out = `/**
 * PSGC reference data — GENERATED, do not edit by hand.
 *
 * Regenerate with:
 *   npm i --no-save ph-geo-admin-divisions
 *   node libs/shared-utils/scripts/generate-psgc.mjs
 *
 * Source: ph-geo-admin-divisions (ISC), which packages the PSA's
 * Philippine Standard Geographic Code. See the generator for what is
 * filtered out and why, and for the one place this deviates from the
 * source (the Maguindanao split).
 *
 * ${regionRows.length} regions · ${provinceRows.length} provinces · ${cityRows.length} cities and municipalities
 */

import type { PsgcCity, PsgcProvince, PsgcRegion } from "./psgc";

export const PSGC_REGIONS_DATA: ReadonlyArray<PsgcRegion> = [
${regionRows.map((r) => `  { code: ${lit(r.code)}, name: ${lit(r.name)}, longName: ${lit(r.longName)} },`).join("\n")}
];

export const PSGC_PROVINCES_DATA: ReadonlyArray<PsgcProvince> = [
${provinceRows.map((p) => `  { code: ${lit(p.code)}, name: ${lit(p.name)}, regionCode: ${lit(p.regionCode)} },`).join("\n")}
];

export const PSGC_CITIES_DATA: ReadonlyArray<PsgcCity> = [
${cityRows.map((c) => `  { code: ${lit(c.code)}, name: ${lit(c.name)}, provinceCode: ${lit(c.provinceCode)}, regionCode: ${lit(c.regionCode)}${c.isCapital ? ", isCapital: true" : ""} },`).join("\n")}
];
`;

// ── Barangays, sharded by region ─────────────────────────────────────
//
// 42,046 of them — ~1.3 MB as one file, which is why they're loaded on
// demand rather than bundled. Sharded by region (17 chunks, 1,100 to
// 4,400 each) because an address form only ever needs one region's
// worth, and a single chunk would make the first barangay lookup pay
// for the whole country.
//
// Only names are stored, keyed by city code. Nothing reads a barangay
// code — the customer row holds the name — and dropping it roughly
// halves each chunk.
const chunkDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "psgc-barangays",
);
mkdirSync(chunkDir, { recursive: true });

const byRegion = new Map();
for (const b of baranggays) {
  // Verified against the full set: every barangay's city is its own
  // PSGC id with the barangay digits cleared.
  const cityCode = b.psgcId.slice(0, 7) + "000";
  const perRegion = byRegion.get(b.regionId) ?? new Map();
  const names = perRegion.get(cityCode) ?? [];
  names.push(b.name);
  perRegion.set(cityCode, names);
  byRegion.set(b.regionId, perRegion);
}

const chunkFiles = [];
for (const region of regionRows) {
  const perRegion = byRegion.get(region.regionId);
  if (!perRegion) continue;
  const entries = [...perRegion.entries()].sort((a, b2) =>
    a[0].localeCompare(b2[0]),
  );
  const body = entries
    .map(
      ([cityCode, names]) =>
        `  ${JSON.stringify(cityCode)}: ${JSON.stringify(names.sort((a, b2) => a.localeCompare(b2)))},`,
    )
    .join(NEWLINE);
  const total = entries.reduce((n, [, names]) => n + names.length, 0);
  writeFileSync(
    join(chunkDir, `${region.regionId}.ts`),
    `/** GENERATED — ${region.name}: ${total} barangays across ${entries.length} cities. */
export const BARANGAYS: Record<string, string[]> = {
${body}
};
`,
    "utf8",
  );
  chunkFiles.push({ regionId: region.regionId, code: region.code, total });
}

writeFileSync(
  join(chunkDir, "index.ts"),
  `/**
 * GENERATED — dynamic-import map for the barangay chunks.
 *
 * Written as an explicit literal rather than a template path so the
 * bundler can see every chunk and split them; \`import(\`./\${id}\`)\`
 * would either fail to resolve or pull all seventeen into one.
 */
export const BARANGAY_CHUNKS: Record<
  string,
  () => Promise<{ BARANGAYS: Record<string, string[]> }>
> = {
${chunkFiles.map((c) => `  ${JSON.stringify(c.code)}: () => import("./${c.regionId}"),`).join(NEWLINE)}
};
`,
  "utf8",
);
console.log(
  `wrote ${chunkFiles.length} barangay chunks, ${chunkFiles.reduce((n, c) => n + c.total, 0)} barangays`,
);

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "psgc.data.ts",
);
writeFileSync(target, out, "utf8");
console.log(
  `wrote ${target}: ${regionRows.length} regions, ${provinceRows.length} provinces, ${cityRows.length} cities`,
);
