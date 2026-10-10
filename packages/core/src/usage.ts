import type { Clock } from './types';
import { systemClock } from './types';
import type { LlmPort, LlmRequest, LlmResponse } from './llm';

/**
 * ACU = "AI compute unit", the billing unit for LLM usage.
 *
 * !!! PLACEHOLDER FORMULA !!! 1 ACU per 1,000 tokens (input + output), to 3 decimal places.
 * The real rate card is a commercial decision; change it here and nowhere else.
 */
export function computeAcu(inputTokens: number, outputTokens: number): number {
  return Math.round(inputTokens + outputTokens) / 1000;
}

export interface UsageRecord {
  userId: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  acu: number;
  at: string;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  acu: number;
}

export interface UsageMeter {
  record(entry: UsageRecord): Promise<void>;
  list(userId: string): Promise<UsageRecord[]>;
  totals(userId: string): Promise<UsageTotals>;
  /** Removes every record of one account (account deletion). */
  deleteForUser(userId: string): Promise<void>;
  /** ACU spent since an instant, by one account or (userId null) by everyone. The LLM ceiling (NFR-5). */
  acuSince(userId: string | null, since: string): Promise<number>;
}

export class InMemoryUsageMeter implements UsageMeter {
  private readonly records: UsageRecord[] = [];

  async record(entry: UsageRecord): Promise<void> {
    this.records.push({ ...entry });
  }

  async acuSince(userId: string | null, since: string): Promise<number> {
    const sum = this.records.filter((r) => (userId === null || r.userId === userId) && r.at >= since).reduce((a, r) => a + r.acu, 0);
    return Math.round(sum * 1000) / 1000;
  }

  async list(userId: string): Promise<UsageRecord[]> {
    return this.records.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async deleteForUser(userId: string): Promise<void> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) if (this.records[i]?.userId === userId) this.records.splice(i, 1);
  }

  async totals(userId: string): Promise<UsageTotals> {
    const mine = this.records.filter((r) => r.userId === userId);
    const sum = (f: (r: UsageRecord) => number) => mine.reduce((a, r) => a + f(r), 0);
    return {
      calls: mine.length,
      inputTokens: sum((r) => r.inputTokens),
      outputTokens: sum((r) => r.outputTokens),
      acu: Math.round(sum((r) => r.acu) * 1000) / 1000,
    };
  }
}

/** Wraps an LlmPort so every successful call is metered against a user and a purpose. */
export function meteredLlm(
  llm: LlmPort,
  meter: UsageMeter,
  scope: { userId: string; purpose: string },
  clock: Clock = systemClock,
): LlmPort {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      const res = await llm.complete(request);
      await meter.record({
        userId: scope.userId,
        purpose: scope.purpose,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        acu: computeAcu(res.inputTokens, res.outputTokens),
        at: clock().toISOString(),
      });
      return res;
    },
  };
}

/**
 * ============================ NOT IMPLEMENTED - SEAM ONLY ============================
 * BitriPay is the group's own payment rail. Its real API is NOT known to this codebase
 * and nothing below describes it. This interface only states what OpennJob needs from a
 * billing provider, in OpennJob's own terms. The developer who integrates BitriPay writes
 * an adapter that implements this port against BitriPay's actual API and may reshape
 * this interface to fit. There is deliberately no implementation and no fake.
 * =====================================================================================
 */
export interface BitriPayBillingPort {
  /** Charge (or deduct from a prepaid balance) the ACU consumed by a user in a period. */
  settleUsage(input: {
    userId: string;
    acu: number;
    periodStart: string;
    periodEnd: string;
  }): Promise<{ reference: string }>;
}
