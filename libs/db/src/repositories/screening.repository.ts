/**
 * AML screening persistence. Each screen produces an `AmlScreening` row;
 * the latest row for a customer is the current status. Overrides are also
 * stored as a row (`OVERRIDDEN`) so the audit trail is complete.
 */

import type { AmlProvider, MatchHit, ScreenStatus } from '@loan/screening';
import type {
  AmlScreening,
  AmlStatus,
  AmlWatchlistEntry,
  PrismaClient,
} from '@prisma/client';

export class ScreeningRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: AmlProvider,
  ) {}

  // ─── Screenings ────────────────────────────────────────────────────

  listForCustomer(customerId: string): Promise<AmlScreening[]> {
    return this.prisma.amlScreening.findMany({
      where: { customerId },
      orderBy: { screenedAt: 'desc' },
    });
  }

  async latestForCustomer(customerId: string): Promise<AmlScreening | null> {
    return this.prisma.amlScreening.findFirst({
      where: { customerId },
      orderBy: { screenedAt: 'desc' },
    });
  }

  async screen(customerId: string): Promise<AmlScreening> {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new Error('Customer not found');
    const result = await this.provider.screen({
      fullName: `${c.firstName} ${c.middleName ?? ''} ${c.lastName}`.replace(/\s+/g, ' ').trim(),
      dateOfBirth: c.dateOfBirth.toISOString().slice(0, 10),
    });
    return this.prisma.amlScreening.create({
      data: {
        customerId,
        status: result.status as AmlStatus,
        provider: this.provider.name,
        providerRef: result.providerRef,
        matches: result.matches as never,
      },
    });
  }

  async override(
    customerId: string,
    note: string,
    overriddenById: string,
  ): Promise<AmlScreening> {
    return this.prisma.amlScreening.create({
      data: {
        customerId,
        status: 'OVERRIDDEN' as AmlStatus,
        provider: this.provider.name,
        notes: note,
        overriddenById,
        overriddenAt: new Date(),
      },
    });
  }

  // ─── Watchlist (mock provider's data source) ───────────────────────

  listWatchlist(): Promise<AmlWatchlistEntry[]> {
    return this.prisma.amlWatchlistEntry.findMany({ orderBy: { fullName: 'asc' } });
  }

  addWatchlistEntry(input: {
    list: string;
    fullName: string;
    aliases?: string[];
    reason?: string;
  }): Promise<AmlWatchlistEntry> {
    return this.prisma.amlWatchlistEntry.create({
      data: {
        list: input.list,
        fullName: input.fullName,
        aliases: input.aliases ?? [],
        reason: input.reason,
      },
    });
  }

  removeWatchlistEntry(id: string): Promise<AmlWatchlistEntry> {
    return this.prisma.amlWatchlistEntry.delete({ where: { id } });
  }

  /** Loader the MockAmlProvider uses to fetch the current watchlist. */
  watchlistLoader(): () => Promise<
    Array<{ list: string; fullName: string; aliases: string[]; reason: string | null }>
  > {
    return async () => {
      const rows = await this.prisma.amlWatchlistEntry.findMany();
      return rows.map((r) => ({
        list: r.list,
        fullName: r.fullName,
        aliases: r.aliases,
        reason: r.reason,
      }));
    };
  }
}

// Helper for external callers
export type { MatchHit, ScreenStatus };
