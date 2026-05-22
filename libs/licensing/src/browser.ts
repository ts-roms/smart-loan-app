/**
 * Browser-safe subset of @loan/licensing.
 *
 * The main `@loan/licensing` entry re-exports the Ed25519 sign/verify
 * code, which depends on Node built-ins (`node:crypto`, `node:fs`,
 * `Buffer`). The marketing site and any other browser bundle only
 * needs the pure metadata — tier definitions, feature catalogs, the
 * tier hierarchy — so we surface those separately here.
 *
 * Anything you import here MUST stay free of Node-only modules.
 * Adding `import { signLicense } from "./sign"` here would defeat
 * the point.
 */

export { TIER_FEATURES, TIER_SEATS, defaultFeaturesForTier } from "./features";
export {
  FEATURE_FLAGS,
  LICENSE_FORMAT_VERSION,
  LICENSE_TIERS,
  LICENSE_TOKEN_PREFIX,
  type FeatureFlag,
  type LicensePayload,
  type LicenseTier,
} from "./types";
