/**
 * Scheduler wrapper for the weekly Actual Budget → Slack digest.
 *
 * Runs as the container's entrypoint (see Dockerfile CMD). Two jobs:
 *
 *   7:00 AM Sunday  — bank-sync.js: syncs all active accounts via SimpleFIN,
 *                     writes results to /tmp/sync-results.json
 *   7:30 AM Sunday  — weekly-digest.js: reads sync results, posts digest to Slack
 *
 * Both scripts can also be run directly for manual testing — they bypass
 * this scheduler entirely. Run bank-sync.js first if you want sync results
 * included in a manual digest run.
 *
 * Timezone is Pacific, enforced via the TZ env var in docker-compose.yml.
 */

const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');

const BANK_SYNC_SCRIPT = path.join(__dirname, 'bank-sync.js');
const DIGEST_SCRIPT = path.join(__dirname, 'weekly-digest.js');

const SYNC_SCHEDULE   = '0 7 * * 0';  // 7:00 AM Sunday Pacific
const DIGEST_SCHEDULE = '30 7 * * 0'; // 7:30 AM Sunday Pacific

function run(label, scriptPath) {
  return new Promise((resolve) => {
    console.log(`[scheduler] Starting ${label} at ${new Date().toISOString()}`);
    execFile('node', [scriptPath], { env: process.env }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (err) {
        console.error(`[scheduler] ${label} exited with error (code ${err.code}):`, err.message);
      } else {
        console.log(`[scheduler] ${label} completed successfully.`);
      }
      resolve(); // always resolve — a sync failure shouldn't block the digest
    });
  });
}

console.log(`[scheduler] Starting.`);
console.log(`[scheduler] Bank sync: ${SYNC_SCHEDULE} | Digest: ${DIGEST_SCHEDULE} (Pacific time)`);
console.log(`[scheduler] Next Sunday: ${getNextSunday()}`);

cron.schedule(SYNC_SCHEDULE, () => run('bank-sync', BANK_SYNC_SCRIPT));
cron.schedule(DIGEST_SCHEDULE, () => run('digest', DIGEST_SCRIPT));

process.on('SIGTERM', () => {
  console.log('[scheduler] Received SIGTERM, shutting down gracefully.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[scheduler] Received SIGINT, shutting down.');
  process.exit(0);
});

function getNextSunday() {
  const now = new Date();
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilSunday);
  next.setHours(7, 0, 0, 0);
  return next.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
}
