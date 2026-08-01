/**
 * Shared PDF chrome — header band, footer, money formatter. Kept separate
 * so the three renderers don't duplicate layout primitives.
 *
 * We use pdfkit's built-in Helvetica throughout. No external font files
 * to ship, no licensing surprises.
 */

import PDFDocument from "pdfkit";

export interface ChromeOptions {
  /** Lender's name (top-left of the header band). */
  companyName: string;
  /** Document title (right of header). */
  title: string;
  /** Optional document number shown under title. */
  documentNumber?: string;
}

export const MARGIN = 50;
export const PAGE_WIDTH = 612; // US Letter
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

/** Build a new doc + paint the header. Returns the doc ready for body content. */
export function startDoc(
  opts: ChromeOptions,
): InstanceType<typeof PDFDocument> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: opts.title, Author: opts.companyName },
  });

  // Header band.
  doc
    .fillColor("#1e293b")
    .rect(0, 0, PAGE_WIDTH, 60)
    .fill()
    .fillColor("white")
    .fontSize(18)
    .font("Helvetica-Bold")
    .text(opts.companyName, MARGIN, 18)
    .fontSize(12)
    .font("Helvetica")
    .text(opts.title, MARGIN, 18, { align: "right", width: CONTENT_WIDTH });
  if (opts.documentNumber) {
    doc.fontSize(9).text(opts.documentNumber, MARGIN, 38, {
      align: "right",
      width: CONTENT_WIDTH,
    });
  }

  // Reset cursor below the header band.
  doc.fillColor("black").fontSize(10).font("Helvetica").moveDown(2);
  doc.y = 80;

  return doc;
}

/** Two-column key/value line. */
export function kv(
  doc: InstanceType<typeof PDFDocument>,
  label: string,
  value: string,
  opts: { leftWidth?: number } = {},
): void {
  const leftW = opts.leftWidth ?? 160;
  const y = doc.y;
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#475569")
    .text(label, MARGIN, y, { width: leftW });
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor("black")
    .text(value, MARGIN + leftW + 10, y, { width: CONTENT_WIDTH - leftW - 10 });
  doc.moveDown(0.4);
}

/** Section heading with underline. */
export function section(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
): void {
  doc.moveDown(0.8);
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor("#1e293b")
    .text(title.toUpperCase(), MARGIN, doc.y);
  const lineY = doc.y + 2;
  doc
    .moveTo(MARGIN, lineY)
    .lineTo(MARGIN + CONTENT_WIDTH, lineY)
    .strokeColor("#cbd5e1")
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.4);
  doc.fillColor("black").font("Helvetica").fontSize(10);
}

export function paragraph(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
): void {
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor("#1e293b")
    .text(text, MARGIN, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
  doc.moveDown(0.5);
}

export function moneyPHP(n: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 2,
  }).format(n);
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

/** Paint a simple table; each row is an array of strings, evenly columned. */
export function table(
  doc: InstanceType<typeof PDFDocument>,
  rows: string[][],
  opts: {
    header?: string[];
    columnWidths?: number[];
    alignments?: Array<"left" | "right" | "center">;
  },
): void {
  const cols = opts.header ? opts.header.length : (rows[0]?.length ?? 0);
  if (cols === 0) return;
  const widths =
    opts.columnWidths ??
    Array.from({ length: cols }, () => Math.floor(CONTENT_WIDTH / cols));
  const aligns =
    opts.alignments ?? Array.from({ length: cols }, () => "left" as const);

  const drawRow = (cells: string[], bold = false) => {
    const startY = doc.y;
    let x = MARGIN;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(8.5)
      .fillColor("black");
    for (let i = 0; i < cols; i++) {
      doc.text(cells[i] ?? "", x, startY, {
        width: widths[i],
        align: aligns[i],
      });
      x += widths[i]!;
    }
    // Move y forward by the tallest cell. pdfkit's text() already advanced
    // doc.y for the LAST cell; for short text, all cells fit on one line so
    // we don't need extra logic for the MVP.
    doc.moveDown(0.2);
  };

  if (opts.header) {
    drawRow(opts.header, true);
    const lineY = doc.y;
    doc
      .moveTo(MARGIN, lineY)
      .lineTo(MARGIN + CONTENT_WIDTH, lineY)
      .strokeColor("#cbd5e1")
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.2);
  }
  for (const row of rows) drawRow(row);
}

/**
 * Signature block. When a signer has a `signature` PNG buffer it's embedded
 * above the signature line — no ink needed. A `signedAt` timestamp under
 * the name renders as an audit trail.
 */
export function signatureBlock(
  doc: InstanceType<typeof PDFDocument>,
  signers: Array<{
    label: string;
    nameHint?: string;
    signature?: Buffer | null;
    signedAt?: Date | null;
  }>,
): void {
  doc.moveDown(2);
  const cellW = CONTENT_WIDTH / signers.length;
  const y = doc.y;
  const lineY = y + 30;
  signers.forEach((s, i) => {
    const x = MARGIN + i * cellW;
    if (s.signature) {
      try {
        doc.image(s.signature, x + 15, y - 5, {
          fit: [cellW - 30, 32],
          align: "center",
          valign: "bottom",
        });
      } catch {
        // pdfkit throws on unsupported image formats; fall back to a blank line.
      }
    }
    doc
      .strokeColor("#1e293b")
      .lineWidth(0.5)
      .moveTo(x + 10, lineY)
      .lineTo(x + cellW - 10, lineY)
      .stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor("#1e293b")
      .text(s.label, x, lineY + 6, { width: cellW, align: "center" });
    if (s.nameHint) {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#64748b")
        .text(s.nameHint, x, lineY + 20, { width: cellW, align: "center" });
    }
    if (s.signedAt) {
      doc
        .font("Helvetica-Oblique")
        .fontSize(7)
        .fillColor("#94a3b8")
        .text(`Signed ${fmtDate(s.signedAt)}`, x, lineY + 32, {
          width: cellW,
          align: "center",
        });
    }
  });
  doc.y = lineY + 50;
}

/**
 * Personnel signature stamp — a compact "Prepared/Issued by" block for
 * documents where the staff member generating the PDF wants to attest to
 * its contents. Distinct from the multi-party signatureBlock used on the
 * agreement, which captures parties to the contract.
 */
export interface PersonnelSignature {
  name: string;
  /** Display label, e.g. "Prepared by", "Issued by", "Approved by". */
  label?: string;
  role?: string;
  signature: Buffer | null;
  signedAt?: Date | null;
}

export function personnelStamp(
  doc: InstanceType<typeof PDFDocument>,
  personnel: PersonnelSignature,
): void {
  const label = personnel.label ?? "Prepared by";
  doc.moveDown(2);
  const y = doc.y;
  const cellW = CONTENT_WIDTH / 2;
  const lineY = y + 28;
  if (personnel.signature) {
    try {
      doc.image(personnel.signature, MARGIN + 10, y - 5, {
        fit: [cellW - 20, 28],
        align: "center",
        valign: "bottom",
      });
    } catch {
      // unsupported image — fall back to blank line
    }
  }
  doc
    .strokeColor("#1e293b")
    .lineWidth(0.5)
    .moveTo(MARGIN, lineY)
    .lineTo(MARGIN + cellW - 10, lineY)
    .stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#1e293b")
    .text(label, MARGIN, lineY + 6, { width: cellW - 10 });
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#64748b")
    .text(
      personnel.role ? `${personnel.name} · ${personnel.role}` : personnel.name,
      MARGIN,
      lineY + 18,
      { width: cellW - 10 },
    );
  if (personnel.signedAt) {
    doc
      .font("Helvetica-Oblique")
      .fontSize(7)
      .fillColor("#94a3b8")
      .text(`Signed ${fmtDate(personnel.signedAt)}`, MARGIN, lineY + 30, {
        width: cellW - 10,
      });
  }
  doc.y = lineY + 46;
}

export function footer(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#94a3b8")
      .text(
        `${text}    ·    Page ${i + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 30,
        { width: CONTENT_WIDTH, align: "center" },
      );
  }
}
