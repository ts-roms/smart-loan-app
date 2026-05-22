import { z } from "zod";

/**
 * Document streaming has no request body — these schemas validate
 * the `?sign=1` toggle that requests embedding the caller's saved
 * personnel signature.
 */
export const signQuerySchema = z.object({
  sign: z.string().optional(),
});
export type SignQuery = z.infer<typeof signQuerySchema>;

/**
 * Officer endpoints accept `?sign=1` or `?sign=true` to embed the
 * caller's stored default signature into the rendered PDF. Anything
 * else is a no-op — including missing/blank.
 */
export function wantsPersonnelSign(query: SignQuery): boolean {
  return query.sign === "1" || query.sign === "true";
}
