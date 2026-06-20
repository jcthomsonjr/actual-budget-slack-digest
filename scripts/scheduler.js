/**
 * Scheduler wrapper for the weekly Actual Budget → Slack digest.
 *
 * Runs as the container's entrypoint (see Dockerfile CMD). Uses node-cron
 * to fire the digest every Sunday at 8:00 AM Pacific time.
 *
 * weekly-digest.js can still be run directly for manual tests:
 *   node scripts/weekly-digest.js
 * That bypasses this scheduler entirely — no cron involved.
 *
 * node-cron uses the system timezone set in the container via TZ env var
 * (configured in docker-compose.yml). The cron expression itself is just
 * "0 8 * * 0" (8am Sunday) — the TZ env var makes that resolve to Pacific.
 */

const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');

const DIGEST_SCRIPT = path.join(__dirname, 'weekly-digest.js');

// "0 8 * * 0" = 8:00 AM every Sunday.
// Pacific time is enforced via the TZ environment variable in the container,
// not here in the cron expression — keeping the expression simple and the
// timezone concern in one place (docker-compose.yml).
const SCHEDULE = '0 8 * * 0';

console.log(`[scheduler] Starting. Digest will run: ${SCHEDULE} (Pacific time, via TZ env var)`);
console.log(`[scheduler] Next run: ${getNextSunday()}`);

cron.schedule(SCHEDULE, () => {
  const now = new Date().toISOString();
  console.log(`[scheduler] Firing digest at ${now}`);

  execFile('node', [DIGEST_SCRIPT], { env: process.env }, (err, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (err) {
      console.error(`[scheduler] Digest exited with error (code ${err.code}):`, err.message);
    } else {
      console.log(`[scheduler] Digest completed successfully.`);
    }
  });
});

// Keep the process alive between scheduled runs.
// node-cron handles this internally but being explicit makes it clear
// this process is meant to run indefinitely, not exit after one invocation.
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
  next.setHours(8, 0, 0, 0);
  return next.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
}
