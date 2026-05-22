/**
 * Licensing feature — wire-format token activation, status display,
 * boot-time verification. Phase 1a (this file): substrate. Phase 1b
 * (next commit) adds the `app.requireFeature` decorator + UI panel.
 */

export { licensingRoutes } from "./licensing.routes";
export type {
  ActivateResult,
  CurrentLicenseStatus,
  LicenseStatusPayload,
  LicensingService,
} from "./licensing.service";
