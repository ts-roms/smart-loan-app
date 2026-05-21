/**
 * LoanDraft repository — wizard-state persistence. A draft is *not* a
 * LoanApplication; it's a lightweight scratchpad where the officer can
 * leave a half-filled wizard and come back later from another device.
 *
 * Lifecycle:
 *
 *   create()  → wizard opens with no draft yet, this writes the first row
 *   update()  → called from each step's "Save draft" and on step-transition
 *   delete()  → fired on final Submit (after /loans/apply succeeds) and
 *               when the user explicitly discards
 */
import type { LoanDraft, PrismaClient } from "@prisma/client";

export interface LoanDraftCreateInput {
  authorId: string;
  customerId?: string | null;
  productCode?: string | null;
  lastStep?: number;
  formState: unknown;
}

export interface LoanDraftUpdateInput {
  customerId?: string | null;
  productCode?: string | null;
  lastStep?: number;
  formState?: unknown;
}

export class LoanDraftRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Newest-first list of all drafts owned by a given user. */
  async listByAuthor(authorId: string): Promise<LoanDraft[]> {
    return this.prisma.loanDraft.findMany({
      where: { authorId },
      orderBy: { updatedAt: "desc" },
    });
  }

  /** Single draft. Returns null if not found OR not owned by the caller. */
  async findByIdForAuthor(
    id: string,
    authorId: string,
  ): Promise<LoanDraft | null> {
    return this.prisma.loanDraft.findFirst({ where: { id, authorId } });
  }

  async create(input: LoanDraftCreateInput): Promise<LoanDraft> {
    return this.prisma.loanDraft.create({
      data: {
        authorId: input.authorId,
        customerId: input.customerId ?? null,
        productCode: input.productCode ?? null,
        lastStep: input.lastStep ?? 0,
        // Cast through unknown so the JsonValue type accepts our arbitrary
        // wizard state. Server-side we don't validate the shape; final
        // submit re-validates against LoanApplyInput.
        formState: input.formState as never,
      },
    });
  }

  /**
   * Patch a draft. Owner check is done at the route level (404 on
   * mismatch). Only mutates fields explicitly passed; nullable fields
   * are cleared when explicitly set to null.
   */
  async update(id: string, input: LoanDraftUpdateInput): Promise<LoanDraft> {
    return this.prisma.loanDraft.update({
      where: { id },
      data: {
        ...(input.customerId !== undefined
          ? { customerId: input.customerId }
          : {}),
        ...(input.productCode !== undefined
          ? { productCode: input.productCode }
          : {}),
        ...(input.lastStep !== undefined ? { lastStep: input.lastStep } : {}),
        ...(input.formState !== undefined
          ? { formState: input.formState as never }
          : {}),
      },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.loanDraft.delete({ where: { id } });
  }
}
