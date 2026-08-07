const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number | string | null | undefined): string {
  if (value == null) return "₱0.00";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "₱0.00";
  return PHP.format(n);
}

/**
 * Today as "YYYY-MM-DD" in LOCAL time — what a date input should
 * default to.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and gets this
 * wrong for the first eight hours of every day in Manila: at 7am local
 * on the 8th, UTC is still the 7th, so a report screen opened before
 * breakfast pre-filled YESTERDAY and quietly answered a different
 * question than the one asked.
 */
export function todayLocalISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(fractionDigits)}%`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function formatDateTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export {
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  formatPhone,
  isValidPhone,
  phoneChangeError,
  normalizePhone,
  phoneError,
} from "./lib/phone";

export {
  HEARTBEAT_MS,
  MIN_ONLINE_WINDOW_MS,
  onlineWindowMs,
  presenceOf,
  shouldStampHeartbeat,
  type Presence,
} from "./lib/presence";

export {
  PSGC_REGIONS,
  PSGC_PROVINCES,
  PSGC_CITIES,
  provincesForRegion,
  regionHasProvinces,
  citiesForProvince,
  citiesForRegion,
  citiesFor,
  findCity,
  loadBarangaysForCity,
  locateCity,
  regionForName,
  type PsgcRegion,
  type PsgcProvince,
  type PsgcCity,
} from "./lib/psgc";
