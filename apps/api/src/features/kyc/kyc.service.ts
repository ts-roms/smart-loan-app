import type { KycRepository, KycSubmission } from "@loan/db";
import { validateKyc } from "@loan/kyc";

import type { DecideKycInput, SubmitKycInput } from "./schemas.js";

/**
 * KycService — application layer for KYC document submission +
 * decisioning. Wraps the repository so the controller stays HTTP-only
 * and so the duplicate-detection + status-rollup logic stays in one
 * place. The repository itself enforces the dedup rule (throws
 * `KycDuplicateError`); the service forwards that error up to the
 * controller for 409 mapping.
 */
export class KycService {
  constructor(private readonly kyc: KycRepository) {}

  listForCustomer(customerId: string): Promise<KycSubmission[]> {
    return this.kyc.listForCustomer(customerId);
  }

  submit(
    input: SubmitKycInput & { submittedById: string },
  ): Promise<KycSubmission> {
    return this.kyc.submit(input);
  }

  decide(
    id: string,
    input: DecideKycInput & { decidedById: string },
  ): Promise<KycSubmission> {
    return this.kyc.decide(id, input);
  }

  /**
   * Validate the customer's KYC pack against the required-documents
   * rules in @loan/kyc. Returns the rollup the UI uses to show "needs
   * X / Y / Z" hints alongside the per-doc list.
   */
  async statusForCustomer(customerId: string) {
    const docs = await this.kyc.listForCustomer(customerId);
    return validateKyc(docs);
  }
}
