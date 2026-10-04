/**
 * Nightly decay job.
 *
 * Fires at 00:00 UTC — the exact moment the daily window rolls over — and
 * deducts 30 points per missed day for everyone, resetting their active streak.
 * The lazy per-user reconcile in services/decay.js is the backup for when this
 * does not run (server restarted, crashed, machine asleep).
 */
import cron from 'node-cron';
import { reconcileAll } from '../services/decay.js';

/** @type {import('node-cron').ScheduledTask|null} */
let task = null;

async function runOnce(reason) {
  const started = Date.now();
  try {
    const corrected = await reconcileAll();
    console.log(
      `[decay] ${reason}: corrected ${corrected} profile(s) in ${Date.now() - started}ms`
    );
    return { corrected };
  } catch (err) {
    console.error('[decay] reconciliation failed:', err.message);
    return { corrected: 0, error: err.message };
  }
}

export function startDecayJob() {
  // '0 0 0 * * *' with UTC timezone = midnight UTC, every day.
  task = cron.schedule(
    '0 0 0 * * *',
    () => runOnce('scheduled'),
    { scheduled: true, timezone: 'UTC' }
  );

  console.log('[decay] nightly job scheduled for 00:00 UTC');
  return task;
}

export function stopDecayJob() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { runOnce as runDecayNow };