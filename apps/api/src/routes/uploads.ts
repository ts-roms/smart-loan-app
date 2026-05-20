/**
 * Generic file-upload endpoint.
 *
 * Saves the multipart file to UPLOADS_DIR/<subdir>/<random>.<ext> and
 * returns the public URL. Subdirs are whitelisted to avoid `..` or other
 * shenanigans.
 *
 * Auth: any authenticated user can upload. Sub-resources (KYC submit,
 * loan apply, etc.) own the policy of "should *this* user have uploaded
 * this URL?" — the upload itself just hands back a stable URL.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';

const ALLOWED_SUBDIRS = new Set(['kyc', 'selfies', 'collateral', 'misc', 'signatures']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.heic']);

export async function uploadRoutes(app: FastifyInstance) {
  const baseDir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads');

  app.addHook('preHandler', app.authenticate);

  app.post<{ Params: { subdir: string } }>('/:subdir', async (req, reply) => {
    if (!ALLOWED_SUBDIRS.has(req.params.subdir)) {
      return reply.code(400).send({ error: 'BadRequest', message: 'Unknown upload subdir' });
    }
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: 'BadRequest', message: 'No file' });
    }
    const ext = extname(file.filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return reply.code(400).send({
        error: 'BadRequest',
        message: `Unsupported file extension: ${ext || '(none)'}`,
      });
    }
    const targetDir = join(baseDir, req.params.subdir);
    await mkdir(targetDir, { recursive: true });
    const fname = `${randomUUID()}${ext}`;
    const fpath = join(targetDir, fname);
    await pipeline(file.file, createWriteStream(fpath));
    if (file.file.truncated) {
      return reply.code(413).send({ error: 'TooLarge', message: 'File exceeds 5 MB' });
    }
    return reply.code(201).send({
      url: `/uploads/${req.params.subdir}/${fname}`,
      filename: fname,
      mimetype: file.mimetype,
    });
  });
}
