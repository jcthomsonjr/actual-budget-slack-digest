/**
 * Weekly Actual Budget → Slack digest.
 *
 * Shows month-to-date budgeted vs. spent, per category, grouped exactly as
 * they're grouped in Actual. No pro-ration, no pace projection, no
 * traffic-light status — just real numbers, visible.
 *
 * Excludes:
 *   - The group literally named "Ignore" (hardcoded name match — a
 *     deliberate junk-drawer group in this household's Actual setup).
 *   - Any group where is_income is true (the Income group).
 * Everything else is shown as-is, using Actual's own categories/groups.
 *
 * Required environment variables:
 *   ACTUAL_SERVER_URL    e.g. https://budget.thoms.party
 *   ACTUAL_PASSWORD      the Actual server login password
 *   ACTUAL_SYNC_ID       this household's budget sync id
 *   SLACK_WEBHOOK_URL    incoming webhook URL for the household Slack channel
 */

const api = require('@actual-app/api');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const EXCLUDED_GROUP_NAMES = ['Ignore'];

// Actual stores amounts as integers (value * 100). Convert to normal
// dollars for display.
function toDollars(integerAmount) {
  if (integerAmount === null || integerAmount === undefined) return 0;
  return integerAmount / 100;
}

function fmt(dollars) {
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function postToSlack(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const data = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Slack webhook returned ${res.statusCode}: ${body}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const SYNC_RESULTS_FILE = '/tmp/sync-results.json';

// Read bank sync results written by bank-sync.js 30 minutes earlier.
// Returns null if the file doesn't exist (e.g. manual digest run without
// running bank-sync first, or sync script fatally failed before writing).
function readSyncResults() {
  try {
    const raw = fs.readFileSync(SYNC_RESULTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Build a single-line sync status summary for the Slack digest footer.
function syncStatusText(results) {
  if (!results) return '⚠️ No sync results found — bank sync may not have run.';
  if (results.fatalError) return `❌ Bank sync failed: ${results.fatalError}`;

  const parts = [];
  if (results.synced.length)  parts.push(`✅ ${results.synced.length} synced`);
  if (results.failed.length)  parts.push(`❌ ${results.failed.length} failed`);
  if (results.skipped.length) parts.push(`⏭️ ${results.skipped.length} skipped (closed)`);
  return `_Bank sync: ${parts.join(', ')}_`;
}


async function getIncludedGroupsForMonth(monthStr) {
  const budgetMonth = await api.getBudgetMonth(monthStr);

  const includedGroups = [];
  let totalBudgeted = 0;
  let totalSpent = 0;

  for (const group of budgetMonth.categoryGroups) {
    if (EXCLUDED_GROUP_NAMES.includes(group.name)) continue;
    if (group.is_income) continue;

    const categories = (group.categories || []).map((cat) => {
      const budgeted = toDollars(cat.budgeted);
      // spent comes back negative (outflow) from Actual; flip for display
      const spent = Math.abs(toDollars(cat.spent));
      totalBudgeted += budgeted;
      totalSpent += spent;
      return { name: cat.name, budgeted, spent };
    });

    includedGroups.push({ name: group.name, categories });
  }

  return { includedGroups, totalBudgeted, totalSpent };
}

// Decide whether this Sunday's digest should also include a close-out of
// last month. Reasoning: if last month's final Sunday landed late enough
// in that month (day 24+), it already gave a near-complete close-out, so
// there's no gap to fill. If last month's final Sunday landed earlier
// (because this month's first Sunday falls on day 1-6), there's up to a
// week of last month's spend that was never shown in its own "final" form.
// Equivalently: only show both if today is the first Sunday of the month
// AND that first Sunday falls on day 6 or earlier.
//
// NOTE: this assumes the script only runs on Sundays (enforced by the
// cron/scheduler, not by this function). If you run this manually on a
// non-Sunday to test, the day-of-month check below will still fire based
// purely on the date — e.g. a manual run on a Tuesday the 3rd will be
// treated the same as a Sunday the 3rd. That's fine for testing the
// month-section logic, just don't mistake it for "this only applies on
// real Sundays" — it doesn't check the weekday at all.
function shouldShowLastMonth(now) {
  const dayOfMonth = now.getDate();
  if (dayOfMonth > 7) return false; // not even the first Sunday of the month
  return dayOfMonth <= 6;
}

function monthStrFor(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabelFor(date) {
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function rawText(text) {
  return { type: 'raw_text', text };
}

function rawTextBold(text) {
  // Table cells don't expose a real color property in the documented
  // schema, so over-budget rows get two independent visual signals
  // instead: a leading 🔴 and bold-styled text via a rich_text cell.
  // (raw_text cells render plain; bold needs the rich_text cell type.)
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_section',
        elements: [{ type: 'text', text, style: { bold: true } }],
      },
    ],
  };
}

function renderGroupTables(blocks, groups) {
  for (const group of groups) {
    // Skip categories with no spend this month — nothing to show.
    const activeCategories = group.categories.filter((cat) => cat.spent > 0);
    if (activeCategories.length === 0) continue;

    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${group.name}*` },
    });

    const headerRow = [rawText('Category'), rawText('Spent'), rawText('Budgeted')];

    const dataRows = activeCategories.map((cat) => {
      const overBudget = cat.budgeted > 0 && cat.spent > cat.budgeted;
      const spentLabel = overBudget ? `🔴 ${fmt(cat.spent)}` : fmt(cat.spent);
      const spentCell = overBudget ? rawTextBold(spentLabel) : rawText(spentLabel);
      return [rawText(cat.name), spentCell, rawText(fmt(cat.budgeted))];
    });

    blocks.push({
      type: 'table',
      column_settings: [{ is_wrapped: true }, { align: 'right' }, { align: 'right' }],
      rows: [headerRow, ...dataRows],
    });
  }
}

// monthSections: array of { monthLabel, groups, totalBudgeted, totalSpent }
// One entry for a normal week. Two entries (last month + current month)
// on the first Sunday of a month when last month didn't get a proper
// close-out the Sunday before — see shouldShowLastMonth().
// syncResults: output of readSyncResults() — null if sync didn't run.
function buildSlackBlocks(monthSections, syncResults) {
  const blocks = [];

  const headerLabel =
    monthSections.length > 1
      ? `${monthSections[0].monthLabel} close-out + ${monthSections[1].monthLabel} so far`
      : monthSections[0].monthLabel;

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📅 Budget Check-in — ${headerLabel}`, emoji: true },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Month-to-date, by category. No judgment, just the numbers.' }],
  });

  for (const section of monthSections) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*——— ${section.monthLabel} ———*` },
    });

    renderGroupTables(blocks, section.groups);

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `*${section.monthLabel} total:* ${fmt(section.totalSpent)} spent / ${fmt(section.totalBudgeted)} budgeted`,
        },
      ],
    });
  }

  // Sync status footer — shows bank sync results from the 7:00 AM run.
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: syncStatusText(syncResults) }],
  });

  return blocks;
}

async function main() {
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  const missing = ['ACTUAL_SERVER_URL', 'ACTUAL_PASSWORD', 'ACTUAL_SYNC_ID', 'SLACK_WEBHOOK_URL'].filter(
    (name) => !process.env[name]
  );
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const dataDir = '/tmp/actual-cache';
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Connecting to ${serverURL} ...`);
  await api.init({ serverURL, password, dataDir });

  try {
    await api.downloadBudget(syncId);

    const now = new Date();
    const monthSections = [];

    if (shouldShowLastMonth(now)) {
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthStr = monthStrFor(lastMonthDate);
      const lastMonthLabel = monthLabelFor(lastMonthDate);
      console.log(`First Sunday of the month (day ${now.getDate()}) — including ${lastMonthLabel} close-out.`);

      const { includedGroups, totalBudgeted, totalSpent } = await getIncludedGroupsForMonth(lastMonthStr);
      monthSections.push({
        monthLabel: lastMonthLabel,
        groups: includedGroups,
        totalBudgeted,
        totalSpent,
      });
    }

    const currentMonthStr = monthStrFor(now);
    const currentMonthLabel = monthLabelFor(now);
    const { includedGroups, totalBudgeted, totalSpent } = await getIncludedGroupsForMonth(currentMonthStr);
    monthSections.push({
      monthLabel: currentMonthLabel,
      groups: includedGroups,
      totalBudgeted,
      totalSpent,
    });

    const syncResults = readSyncResults();
    const blocks = buildSlackBlocks(monthSections, syncResults);

    console.log('Posting to Slack ...');
    await postToSlack(webhookUrl, { blocks });
    console.log('Done.');
  } finally {
    await api.shutdown();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
