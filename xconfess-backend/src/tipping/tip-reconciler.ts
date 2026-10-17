import { emitLagMetric } from '../logger';

export type TipFinalityState = 'PENDING_TIP' | 'FINALIZED' | 'FAILED';

export interface PendingTipRecord {
  id?: string | number;
  confessionId: string | number;
  txHash: string;
  logicalTxId: string;
  status: TipFinalityState | string;
  createdAt: Date | string;
  replacedByTxHash?: string | null;
  replacesTxHash?: string | null;
}

export interface TipReconcilerDb {
  tips: {
    findMany: (args: {
      where: {
        status: { in: string[] };
        logicalTxId?: { not: null };
      };
    }) => Promise<PendingTipRecord[]>;
  };
}

/**
 * Statuses that are still eligible for reconciliation. FINALIZED tips are
 * intentionally excluded so a fee-bumped replacement (which shares the same
 * logicalTxId as its original) cannot be re-processed and double-counted.
 */
const RECONCILABLE_STATUSES: string[] = ['PENDING_TIP', 'FAILED'];

/**
 * Collapse pending tips by logicalTxId so that a fee-bumped replacement and
 * its original are treated as one logical operation. The most recent record
 * (by createdAt, falling back to array order) wins for lag measurement.
 */
export const collapseByLogicalTxId = (
  tips: PendingTipRecord[],
): PendingTipRecord[] => {
  const byLogicalId = new Map<string, PendingTipRecord>();

  for (const tip of tips) {
    // Skip anything already finalized at the record level.
    if (tip.status === 'FINALIZED') {
      continue;
    }

    const key = String(tip.logicalTxId ?? tip.txHash);
    const existing = byLogicalId.get(key);

    if (!existing) {
      byLogicalId.set(key, tip);
      continue;
    }

    const existingTime = new Date(existing.createdAt).getTime();
    const candidateTime = new Date(tip.createdAt).getTime();

    if (
      Number.isNaN(existingTime) ||
      (!Number.isNaN(candidateTime) && candidateTime >= existingTime)
    ) {
      byLogicalId.set(key, tip);
    }
  }

  return Array.from(byLogicalId.values());
};

export const processPendingTips = async (db: TipReconcilerDb) => {
  const pendingTips = await db.tips.findMany({
    where: {
      status: { in: RECONCILABLE_STATUSES },
      logicalTxId: { not: null },
    },
  });

  // Collapse fee-bump replacements into a single logical tip before
  // measuring lag so replacements do not double-count.
  const logicalTips = collapseByLogicalTxId(pendingTips);

  for (const tip of logicalTips) {
    // Skip tips already finalized (defensive; query already filters these).
    if (tip.status === 'FINALIZED') {
      continue;
    }

    // REQUIRED: Measure and log the lag for tips, keyed by logicalTxId so
    // fee-bumped replacements share a single lag series.
    emitLagMetric(
      'tip',
      tip.confessionId,
      tip.logicalTxId,
      tip.createdAt,
    );

    // Continue with existing tipping logic...
  }

  return logicalTips;
};