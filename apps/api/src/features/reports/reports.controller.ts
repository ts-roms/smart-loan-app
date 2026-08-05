import type { FastifyReply, FastifyRequest } from "fastify";

import { querySchema, reportTypeSchema } from "./schemas";

/**
 * HTTP adapter for compliance reports. Owns:
 *   - parsing the date-range query + format flag
 *   - mapping `:type` to one of the supported report kinds (404 on
 *     misspellings — the user knows what they meant, the URL says they
 *     don't)
 *   - serializing to either JSON (default) or CSV with the right
 *     Content-Disposition header so the browser triggers a download
 *
 * Phase 2: stateless. Reads `req.reportsServices!.reports` per call.
 */
export class ReportsController {
  generate = async (
    req: FastifyRequest<{ Params: { type: string } }>,
    reply: FastifyReply,
  ) => {
    const parsedQuery = querySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsedQuery.error.issues });
    }
    const parsedType = reportTypeSchema.safeParse(req.params.type);
    if (!parsedType.success) {
      return reply.code(404).send({
        error: "NotFound",
        message: `Unknown report type: ${req.params.type}`,
      });
    }

    const from = parsedQuery.data.from
      ? new Date(parsedQuery.data.from)
      : undefined;
    const to = parsedQuery.data.to ? new Date(parsedQuery.data.to) : undefined;
    const bundle = await req.reportsServices!.reports.generate(
      parsedType.data,
      {
        from,
        to,
        province: parsedQuery.data.province,
        city: parsedQuery.data.city,
      },
    );

    if (parsedQuery.data.format === "csv") {
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${bundle.filename}.csv"`,
      );
      return reply.send(toCsv(bundle.rows));
    }
    return bundle.rows;
  };
}

/**
 * Minimal RFC-4180-ish CSV serializer. Quotes fields containing comma,
 * quote, or newline; doubles embedded quotes. Lives in the controller
 * because it's HTTP-layer concern only (Content-Disposition triggers
 * the download, this fills the body).
 */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  // Union of all keys — rows may have different shape (e.g. the
  // annual-docs summary row vs detail rows).
  const keys = Array.from(
    rows.reduce<Set<string>>((s, r) => {
      Object.keys(r).forEach((k) => s.add(k));
      return s;
    }, new Set()),
  );
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(",")];
  for (const r of rows) {
    lines.push(keys.map((k) => escape(r[k])).join(","));
  }
  return lines.join("\n");
}
