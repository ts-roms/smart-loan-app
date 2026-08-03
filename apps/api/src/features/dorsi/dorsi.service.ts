import type { AuditLogRepository, DorsiRepository } from "@loan/db";

import type {
  BoardApprovalInput,
  CheckInput,
  DeactivateInput,
  TagInput,
} from "./schemas";

/**
 * DorsiService — application layer for. The repository
 * (libs/db) owns storage + the utilization math; the service adds
 * audit-log writes around every state-changing operation so a single
 * place owns the "what happened, who did it" contract.
 *
 * Audit recording sits in the service (not the controller) because
 * the audit row's `targetId` is only known after the create call
 * succeeds — keeping the two together in one method guarantees we
 * never log an action for a row that didn't actually persist.
 */
export class DorsiService {
  constructor(
    private readonly repo: DorsiRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  listActive() {
    return this.repo.listActive();
  }

  utilization() {
    return this.repo.utilization();
  }

  findForCustomer(customerId: string) {
    return this.repo.findForCustomer(customerId);
  }

  systemConfig() {
    return this.repo.systemConfig();
  }

  findBoardApprovalForLoan(loanId: string) {
    return this.repo.findBoardApprovalForLoan(loanId);
  }

  screenByName(name: string) {
    return this.repo.screenByName(name.trim());
  }

  checkLoan(input: CheckInput) {
    return this.repo.checkLoan(input);
  }

  async tag(input: TagInput, actorId: string) {
    const created = await this.repo.tag({
      customerId: input.customerId,
      category: input.category,
      basis: input.basis,
      taggedById: actorId,
    });
    await this.audit.record({
      action: "DORSI_TAG",
      actorId,
      targetType: "DorsiRecord",
      targetId: created.id,
      payload: input,
    });
    return created;
  }

  async deactivate(id: string, input: DeactivateInput, actorId: string) {
    const updated = await this.repo.deactivate(id, {
      reason: input.reason,
      deactivatedById: actorId,
    });
    await this.audit.record({
      action: "DORSI_DEACTIVATE",
      actorId,
      targetType: "DorsiRecord",
      targetId: id,
      payload: input,
    });
    return updated;
  }

  async markReviewed(id: string, actorId: string) {
    const updated = await this.repo.markReviewed(id, actorId);
    await this.audit.record({
      action: "DORSI_REVIEW",
      actorId,
      targetType: "DorsiRecord",
      targetId: id,
    });
    return updated;
  }

  async recordBoardApproval(input: BoardApprovalInput, actorId: string) {
    const approval = await this.repo.recordBoardApproval({
      loanId: input.loanId,
      meetingDate: new Date(input.meetingDate),
      minutesRef: input.minutesRef,
      note: input.note,
      approvedById: actorId,
    });
    await this.audit.record({
      action: "DORSI_BOARD_APPROVE",
      actorId,
      targetType: "DorsiBoardApproval",
      targetId: approval.id,
      payload: input,
    });
    return approval;
  }

  async updateCompanyTotalEquity(value: number, actorId: string) {
    const result = await this.repo.updateCompanyTotalEquity(value, actorId);
    await this.audit.record({
      action: "SYSTEM_CONFIG_UPDATE",
      actorId,
      targetType: "SystemConfig",
      payload: { companyTotalEquity: value },
    });
    return result;
  }
}
