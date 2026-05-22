/**
 * @loan/licensing — Ed25519-signed offline license tokens.
 *
 *   - `sign.ts`      — produce a token from a payload + private key
 *   - `verify.ts`    — verify a wire-format token against a public key
 *   - `types.ts`     — payload shape, tier enum, feature catalog
 *   - `features.ts`  — default tier→features mapping (the price list)
 *   - `keys.ts`      — env-driven key loading helpers
 *   - `codec.ts`     — base64url helpers
 *
 * No dependencies. The wire format is deliberately tiny + JWS-like so
 * a customer can paste it into a textarea without quoting headaches.
 */

export * from "./codec";
export * from "./features";
export * from "./keys";
export * from "./sign";
export * from "./types";
export * from "./verify";
