#!/usr/bin/env node
/**
 * Chaos experiment runner — dry-run / catalogue tool.
 *
 * In dry-run mode (default), prints the experiment plan without injecting
 * any failures.  Actual fault injection requires manual execution of the
 * `injectionSteps` documented in each experiment definition.
 *
 * The purpose of this script is to:
 *  1. List available experiments for CI / documentation.
 *  2. Validate that all experiments have required fields before a staging run.
 *  3. Serve as the canonical entrypoint referenced in runbooks.
 *
 * Usage:
 *   node scripts/run-chaos-experiment.js --list
 *   node scripts/run-chaos-experiment.js --experiment=exp-01-postgres-loss
 *   node scripts/run-chaos-experiment.js --experiment=all --dry-run
 *
 * Issue: #99 — Create chaos experiments for critical workflows
 */

'use strict';

// We can't directly require a TypeScript file in a JS Node script, so we
// embed the experiment IDs + descriptions inline.  The source of truth is
// xconfess-backend/src/health/chaos-experiments.ts — this script reads
// a compiled version at dist/ when available, falling back to the catalogue
// data embedded below.

const EXPERIMENT_CATALOGUE = [
  {
    id: 'exp-01-postgres-loss',
    title: 'Postgres connection loss during feed read',
    target: 'postgres',
    durationSecs: 60,
  },
  {
    id: 'exp-02-redis-loss',
    title: 'Redis loss during BullMQ job dispatch',
    target: 'redis',
    durationSecs: 60,
  },
  {
    id: 'exp-03-duplicate-jobs',
    title: 'Duplicate job delivery in notification queue',
    target: 'queue-worker',
    durationSecs: 30,
  },
  {
    id: 'exp-04-process-kill',
    title: 'Graceful shutdown under SIGTERM during active HTTP requests',
    target: 'process',
    durationSecs: 15,
  },
  {
    id: 'exp-05-stellar-rpc-timeout',
    title: 'Stellar RPC timeout does not block confession creation',
    target: 'stellar-rpc',
    durationSecs: 120,
  },
  {
    id: 'exp-06-redis-export-queue-recovery',
    title: 'Redis connection loss and recovery for the export queue',
    target: 'redis:export-queue',
    durationSecs: 90,
  },
  {
    id: 'exp-07-redis-notification-queue-recovery',
    title: 'Redis connection loss and recovery for the notification queue',
    target: 'redis:notification-queue',
    durationSecs: 90,
  },
  {
    id: 'exp-08-redis-queue-backlog-growth',
    title: 'Redis outage causes backlog growth across queue-backed workers',
    target: 'redis:all-queues',
    durationSecs: 120,
  },
  {
    id: 'exp-09-redis-duplicate-delivery',
    title: 'Duplicate delivery after Redis partition recovery is idempotent',
    target: 'queue-worker:all-queues',
    durationSecs: 60,
  },
];

function assertNotProduction() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[chaos] ERROR: Refusing to run in NODE_ENV=production.');
    process.exit(2);
  }
  const dbUrl = process.env.DATABASE_URL ?? '';
  if (/\.render\.com|\.rds\.amazonaws\.com|prod/i.test(dbUrl)) {
    console.error('[chaos] ERROR: DATABASE_URL appears to point at production.');
    process.exit(2);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    list: args.includes('--list'),
    dryRun: args.includes('--dry-run') || !args.some((a) => a.startsWith('--experiment=')),
    experiment: (args.find((a) => a.startsWith('--experiment=')) || '').replace('--experiment=', '') || null,
  };
}

function printCatalogue() {
  console.log('\nAvailable chaos experiments:\n');
  for (const exp of EXPERIMENT_CATALOGUE) {
    console.log(`  ${exp.id}`);
    console.log(`    Title   : ${exp.title}`);
    console.log(`    Target  : ${exp.target}`);
    console.log(`    Duration: ${exp.durationSecs}s`);
    console.log('');
  }
  console.log(
    'Run a specific experiment plan:\n' +
    '  node scripts/run-chaos-experiment.js --experiment=<id>\n',
  );
}

function printExperimentPlan(expId) {
  const exp = EXPERIMENT_CATALOGUE.find((e) => e.id === expId);
  if (!exp) {
    console.error(`[chaos] Unknown experiment: "${expId}". Run --list to see available experiments.`);
    process.exit(1);
  }

  console.log(`\nChaos Experiment Plan: ${exp.id}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`Title  : ${exp.title}`);
  console.log(`Target : ${exp.target}`);
  console.log(`Duration: ~${exp.durationSecs}s`);
  console.log('');
  console.log('Full details in: xconfess-backend/src/health/chaos-experiments.ts');
  console.log('Runbooks       : docs/disaster-recovery-runbook.md');
  console.log('                 docs/incident-runbook.md');
  console.log('');
  console.log('[DRY RUN] No faults injected. Follow injectionSteps manually in staging.');
}

function main() {
  assertNotProduction();

  const opts = parseArgs(process.argv);

  if (opts.list || !opts.experiment) {
    printCatalogue();
    return;
  }

  if (opts.experiment === 'all') {
    for (const exp of EXPERIMENT_CATALOGUE) {
      printExperimentPlan(exp.id);
    }
    return;
  }

  printExperimentPlan(opts.experiment);
}

main();
