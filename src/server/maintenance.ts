/**
 * Scheduled maintenance for time-based cleanup.
 *
 * Several records in PipelineOS expire on a deadline but are otherwise only
 * transitioned lazily when an operation happens to touch them:
 *   - Approval cards past `expiresAt` (never revisited if no one commits them).
 *   - Invocation-ledger entries past their idempotency TTL.
 *   - Sourced public prospects past their retention window.
 *
 * In the in-memory demo that lazy pruning is harmless, but a long-running
 * durable store (Firestore) would accumulate stale documents indefinitely.
 * This module runs a periodic sweep that drives those records to their
 * terminal state and prunes expired ledger entries. It returns a stoppable
 * handle so the composition root can shut it down cleanly.
 */

import type { SharedStateRepository } from './repository';
import type { Timestamp } from '../shared/models';
import { applyPublicProspectRetention } from './operations/importPublicProspect';
import { childLogger, type Logger } from './observability/logger';

export interface MaintenanceResult {
  expiredApprovalCards: number;
  prunedLedgerEntries: number;
  expiredProspects: number;
  deletedCandidates: number;
}

export interface MaintenanceOptions {
  repository: SharedStateRepository;
  /** Sweep interval in ms. Env: MAINTENANCE_INTERVAL_MS. Default 5 minutes. */
  intervalMs?: number;
  /** Injected clock for deterministic tests. Defaults to the repository clock. */
  now?: () => Timestamp;
  logger?: Logger;
}

export interface MaintenanceHandle {
  /** Run one sweep immediately and return what it cleaned up. */
  runOnce(): MaintenanceResult;
  /** Stop the periodic timer. Idempotent. */
  stop(): void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function resolveIntervalMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const raw = process.env.MAINTENANCE_INTERVAL_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

/** Perform a single maintenance sweep against the repository and its ledger. */
export function runMaintenanceSweep(options: {
  repository: SharedStateRepository;
  now?: () => Timestamp;
}): MaintenanceResult {
  const { repository } = options;
  const nowIso = (options.now ?? (() => repository.now()))();

  // 1) Expire overdue approval cards (commits one revision only if any change).
  const expiredApprovalCards = repository.sweepExpiredApprovalCards(nowIso).length;

  // 2) Apply public-prospect retention inside a single transaction.
  let expiredProspects = 0;
  let deletedCandidates = 0;
  const retention = repository.transact((draft) =>
    applyPublicProspectRetention(draft, nowIso)
  );
  expiredProspects = retention.expiredProspectIds.length;
  deletedCandidates = retention.deletedCandidateIds.length;

  // 3) Prune expired idempotency-ledger entries when the ledger supports it.
  const ledger = repository.invocationLedger;
  const prunedLedgerEntries =
    typeof ledger.prune === 'function' ? ledger.prune(nowIso) : 0;

  return {
    expiredApprovalCards,
    prunedLedgerEntries,
    expiredProspects,
    deletedCandidates
  };
}

/**
 * Start the periodic maintenance scheduler. The timer is `unref`'d so it never
 * keeps the process alive on its own. Failures in one sweep are logged and do
 * not stop the schedule.
 */
export function startMaintenanceScheduler(
  options: MaintenanceOptions
): MaintenanceHandle {
  const intervalMs = resolveIntervalMs(options.intervalMs);
  const log = options.logger ?? childLogger({ component: 'maintenance' });

  const runOnce = (): MaintenanceResult => {
    const result = runMaintenanceSweep({
      repository: options.repository,
      ...(options.now === undefined ? {} : { now: options.now })
    });
    if (
      result.expiredApprovalCards > 0 ||
      result.prunedLedgerEntries > 0 ||
      result.expiredProspects > 0 ||
      result.deletedCandidates > 0
    ) {
      log.info({ ...result }, 'maintenance sweep cleaned expired records');
    } else {
      log.debug('maintenance sweep found nothing to clean');
    }
    return result;
  };

  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (error) {
      log.error({ err: error }, 'maintenance sweep failed');
    }
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    runOnce,
    stop(): void {
      clearInterval(timer);
    }
  };
}
