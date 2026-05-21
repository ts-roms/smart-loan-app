/**
 * Browser-local OCR for Philippine government IDs (UMID, Driver's
 * License, Passport, SSS, PhilHealth, PRC, etc.). Lazy-loads
 * tesseract.js + the English model on first call so the ~3 MB cost is
 * only paid when an officer actually drops an ID image — the daily
 * loan officer who never uses OCR pays nothing.
 *
 * Everything runs inside the user's browser. The image bytes never
 * leave the machine.
 *
 * Output is a best-effort dictionary of extracted fields plus the raw
 * recognized text — the caller decides which fields to surface for
 * "Apply to form" and which to ignore. Heuristics are designed for PH
 * ID formats; expect 80%-ish accuracy on clean photos, lower on
 * low-light or skewed shots. The officer always confirms.
 */

import type { Worker as TesseractWorker } from "tesseract.js";

/**
 * What the heuristic parser tries to extract. All fields are optional;
 * a poor scan may leave most of them undefined.
 */
export interface ExtractedIdFields {
  /** First given name (best-guess from the longest detected line). */
  firstName?: string;
  /** Surname / family name. */
  lastName?: string;
  /** Combined "First Last" when we couldn't confidently split. */
  fullName?: string;
  /**
   * ISO date "YYYY-MM-DD". Falls back to whatever the parser inferred
   * from the source format (DD/MM/YYYY, DD MON YYYY, etc.).
   */
  dateOfBirth?: string;
  /** Alphanumeric ID number with hyphens preserved. */
  idNumber?: string;
  /** Full address line(s) joined with commas where present. */
  address?: string;
}

export interface IdOcrResult {
  fields: ExtractedIdFields;
  /** Full recognized text — useful for the "show raw" debug surface. */
  text: string;
  /** Tesseract's overall confidence score 0–100. */
  confidence: number;
  /** Model identifier (worker version) for audit / repro. */
  model: string;
}

// Singleton worker — Tesseract spins up a Web Worker + WASM module,
// which is expensive. Reuse across calls.
let workerPromise: Promise<TesseractWorker> | null = null;
const TESSERACT_VERSION_TAG = "tesseract.js/5/eng";

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      // English-only by default — the vast majority of PH IDs print in
      // English regardless of where the data was entered. Loading
      // additional languages roughly doubles the model size, so wait
      // until we know we need them.
      return createWorker("eng");
    })();
  }
  return workerPromise;
}

/**
 * Run OCR against a single image URL. Loads the worker on first call,
 * reuses it across subsequent calls. Throws if the image can't be
 * fetched / decoded; the caller should surface that as a recoverable
 * error (the officer can still type the fields by hand).
 */
export async function runIdOcr(imageUrl: string): Promise<IdOcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageUrl);
  return {
    text: data.text,
    confidence: data.confidence,
    model: TESSERACT_VERSION_TAG,
    fields: parseIdFields(data.text),
  };
}

/**
 * Heuristic field extractor. Examines the OCR text line-by-line plus
 * pattern-matches keyword-prefixed values ("Date of Birth: …",
 * "Name: …"). Designed for PH ID layouts but kept format-tolerant.
 *
 * Strategy:
 *   1. Look for explicit "key: value" lines first (high-confidence).
 *   2. Fall back to pattern-based pickups (date regex, ID-number regex).
 *   3. Best-guess name from the longest mostly-alpha line.
 */
export function parseIdFields(rawText: string): ExtractedIdFields {
  const fields: ExtractedIdFields = {};
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ── 1. Keyword-prefixed fields ─────────────────────────────────
  // Loop once over all lines and collect any "Field: Value" hits.
  // Stop at the first credible match for each field.
  for (const line of lines) {
    if (
      !fields.lastName &&
      /(?:surname|last\s*name)\s*[:\-]\s*(.+)/i.test(line)
    ) {
      fields.lastName = line.replace(/^[^:\-]+[:\-]\s*/, "").trim();
    }
    if (
      !fields.firstName &&
      /(?:given\s*names?|first\s*name)\s*[:\-]\s*(.+)/i.test(line)
    ) {
      fields.firstName = line.replace(/^[^:\-]+[:\-]\s*/, "").trim();
    }
    if (
      !fields.dateOfBirth &&
      /(?:date\s*of\s*birth|d\.?o\.?b\.?|birthday)\s*[:\-]\s*(.+)/i.test(line)
    ) {
      const raw = line.replace(/^[^:\-]+[:\-]\s*/, "").trim();
      fields.dateOfBirth = normalizeDate(raw) ?? raw;
    }
    if (
      !fields.idNumber &&
      /(?:id\s*(?:no|number|#)|crn|prc\s*no|license\s*no|passport\s*no)\s*[:\-]\s*(.+)/i.test(
        line,
      )
    ) {
      const raw = line.replace(/^[^:\-]+[:\-]\s*/, "").trim();
      // ID numbers commonly have hyphens / digits / a letter prefix.
      // Strip everything else (extra commas, trailing dots) but keep
      // the inner shape intact.
      fields.idNumber = raw.replace(/[^A-Z0-9\- ]/gi, "").trim();
    }
    if (!fields.address && /address\s*[:\-]\s*(.+)/i.test(line)) {
      fields.address = line.replace(/^[^:\-]+[:\-]\s*/, "").trim();
    }
  }

  // ── 2. Pattern-based fallbacks ─────────────────────────────────
  // Date of birth: scan for any plausible date if we didn't find a
  // labelled one. Many IDs label it but a few don't.
  if (!fields.dateOfBirth) {
    for (const line of lines) {
      const d = extractDate(line);
      if (d) {
        fields.dateOfBirth = d;
        break;
      }
    }
  }

  // ID number: a long alphanumeric-with-hyphens token where the line
  // doesn't look like a date. We prefer 10+ characters which screens
  // out timestamps and short numbers.
  if (!fields.idNumber) {
    for (const line of lines) {
      const m = line.match(
        /\b([A-Z]{0,4}[-\s]?\d{2,4}(?:[-\s]?\d{2,8}){1,3})\b/i,
      );
      if (m && !extractDate(line)) {
        fields.idNumber = m[1]!
          .replace(/\s+/g, "-")
          .replace(/[^A-Z0-9\-]/gi, "")
          .toUpperCase();
        break;
      }
    }
  }

  // ── 3. Best-guess name from longest mostly-alpha line ──────────
  // Only kicks in if we didn't get a Last+First combo from labels.
  if (!fields.firstName && !fields.lastName && !fields.fullName) {
    const candidate = lines
      .filter((l) => /^[A-Z][A-Z\s.,'\-]{4,60}$/.test(l)) // ALL-CAPS, mostly letters
      .sort((a, b) => b.length - a.length)[0];
    if (candidate) {
      const cleaned = candidate.replace(/[.,]/g, "").trim();
      const parts = cleaned.split(/\s+/);
      if (parts.length >= 2) {
        // PH conventional ordering on UMID/Driver's License is
        // SURNAME, GIVEN-NAMES — but on Passport it's GIVEN SURNAME.
        // We can't reliably tell, so keep the combined string.
        fields.fullName = cleaned;
      } else {
        fields.fullName = cleaned;
      }
    }
  } else if (fields.firstName && fields.lastName && !fields.fullName) {
    fields.fullName = `${fields.firstName} ${fields.lastName}`;
  }

  return fields;
}

/**
 * Try to read any plausible date out of a free-form line. Returns
 * ISO YYYY-MM-DD or null. Permissive on separators but strict on
 * field ordering — assumes MM/DD/YYYY for slash-separated values
 * (most common in PH IDs) unless the year is unambiguously first.
 */
function extractDate(line: string): string | null {
  // Year-first: YYYY-MM-DD or YYYY/MM/DD.
  let m = line.match(/(\d{4})[\-./](\d{1,2})[\-./](\d{1,2})/);
  if (m) {
    return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // Month-day-year (slash or dot separated).
  m = line.match(/\b(\d{1,2})[\-./](\d{1,2})[\-./](\d{4})\b/);
  if (m) {
    // MM/DD/YYYY is more common on PH gov't IDs than DD/MM.
    return iso(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  // "DD MON YYYY" — e.g. "13 JUN 1985".
  m = line.match(
    /\b(\d{1,2})\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\w*\s+(\d{4})\b/i,
  );
  if (m) {
    const monthIdx = [
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC",
    ].indexOf(m[2]!.toUpperCase());
    if (monthIdx >= 0) return iso(Number(m[3]), monthIdx + 1, Number(m[1]));
  }
  return null;
}

function normalizeDate(raw: string): string | null {
  return extractDate(raw);
}

function iso(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Tear down the cached worker. Call from app teardown if you care; in
 * practice the page reload reclaims everything.
 */
export async function terminateOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
