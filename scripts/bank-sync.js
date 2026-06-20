/**
 * Bank sync script — runs 30 minutes before the weekly digest.
 *
 * Connects to Actual Budget, iterates over all non-closed accounts,
 * and calls runBankSync() on each one. Accounts that aren't connected
 * to SimpleFIN (or any other provider) will fail — that's expected and
 * handled gracefully per-account rather than aborting the whole run.
 *
 * Results are written to /tmp/sync-results.json so the digest script
 * can include a sync status line in the Slack post without needing to
 * re-run the sync itself.
 *
 * Required environment variables (same as weekly-digest.js):
 *   ACTUAL_SERVER_URL
 *   ACTUAL_PASSWORD
 *   ACTUAL_SYNC_ID
 */

const api = require('@actual-app/api');
const fs = require('fs');

const RESULTS_FILE = '/tmp/sync-results.json';

async function main() {
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;

  const missing = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID'].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const dataDir = '/tmp/actual-cache';
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`[bank-sync] Connecting to ${serverURL} ...`);
  await api.init({ serverURL, password, dataDir });

  const results = { synced: [], skipped: [], failed: [], timestamp: new Date().toISOString() };

  try {
    await api.downloadBudget(syncId);
    const accounts = await api.getAccounts();
    const activeAccounts = accounts.filter((a) => !a.closed);

    console.log(`[bank-sync] Found ${activeAccounts.length} active accounts, ${accounts.length - activeAccounts.length} closed (skipped).`);

    // Closed accounts are skipped entirely — they're no longer connected
    // to any sync provider and runBankSync would just error on them.
    results.skipped = accounts
      .filter((a) => a.closed)
      .map((a) => a.name);

    for (const account of activeAccounts) {
      try {
        console.log(`[bank-sync] Syncing: ${account.name} ...`);
        await api.runBankSync({ accountId: account.id });
        console.log(`[bank-sync] ✅ ${account.name}`);
        results.synced.push(account.name);
      } catch (err) {
        // Some accounts may be manually entered (no sync provider attached).
        // Log the failure but continue with the rest — don't abort the run.
        console.warn(`[bank-sync] ⚠️ ${account.name}: ${err.message}`);
        results.failed.push({ name: account.name, error: err.message });
      }
    }
  } finally {
    await api.shutdown();
    // Write results inside finally so this always runs, even if some
    // accounts errored during the sync loop — guaranteed delivery to
    // the digest script 30 minutes later regardless of partial failures.
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    console.log(`[bank-sync] Results written to ${RESULTS_FILE}`);
    console.log(`[bank-sync] Done. Synced: ${results.synced.length}, Failed: ${results.failed.length}, Skipped: ${results.skipped.length}`);
  }
}

main().catch((err) => {
  console.error('[bank-sync] Fatal error:', err);
  // Write a failure record so the digest can still report something
  // rather than silently omitting the sync status line.
  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify({ synced: [], skipped: [], failed: [], fatalError: err.message, timestamp: new Date().toISOString() }, null, 2)
  );
  process.exit(1);
});
