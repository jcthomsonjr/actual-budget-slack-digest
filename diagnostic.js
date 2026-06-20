/**
 * Diagnostic script — READ ONLY.
 *
 * Connects to the household's Actual Budget server, downloads the budget,
 * and prints out the real category groups, categories, and current month's
 * budgeted vs. spent amounts. Does NOT post to Slack. Does NOT modify
 * anything in Actual.
 *
 * Purpose: confirm we're looking at real data before building the digest
 * logic against it, instead of guessing at category/group names.
 *
 * Required environment variables:
 *   ACTUAL_SERVER_URL   e.g. https://budget.thoms.party
 *   ACTUAL_PASSWORD     the Actual server login password
 *   ACTUAL_SYNC_ID       5fb965f6-93b2-425f-8df2-e7d19c6dc82e (this household's budget)
 *
 * Run with:
 *   ACTUAL_SERVER_URL=https://budget.thoms.party \
 *   ACTUAL_PASSWORD=xxxx \
 *   ACTUAL_SYNC_ID=5fb965f6-93b2-425f-8df2-e7d19c6dc82e \
 *   node scripts/diagnostic.js
 */

const api = require('@actual-app/api');
const fs = require('fs');

// Actual stores amounts as integers (value * 100). This converts back to
// normal dollars-and-cents for display. Every dollar figure from the API
// needs this conversion — easy to forget, easy to silently produce
// nonsense output if missed.
function toDollars(integerAmount) {
  if (integerAmount === null || integerAmount === undefined) return null;
  return integerAmount / 100;
}

function fmt(dollars) {
  if (dollars === null || dollars === undefined) return 'n/a';
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

async function main() {
  const serverURL = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_PASSWORD;
  const syncId = process.env.ACTUAL_SYNC_ID;

  if (!serverURL || !password || !syncId) {
    console.error('Missing required env vars. Need ACTUAL_SERVER_URL, ACTUAL_PASSWORD, ACTUAL_SYNC_ID.');
    process.exit(1);
  }

  console.log(`Connecting to ${serverURL} ...`);

  const dataDir = '/tmp/actual-cache';
  fs.mkdirSync(dataDir, { recursive: true });

  await api.init({
    serverURL,
    password,
    dataDir, // local cache dir for the downloaded budget copy
  });

  try {
    console.log(`Downloading budget (sync id ${syncId}) ...`);
    await api.downloadBudget(syncId);

    // --- Category groups + nested categories ---
    console.log('\n=== Category Groups & Categories ===\n');
    const groups = await api.getCategoryGroups();

    for (const group of groups) {
      console.log(`GROUP: "${group.name}"  (id: ${group.id})  is_income: ${!!group.is_income}`);
      if (group.categories && group.categories.length) {
        for (const cat of group.categories) {
          console.log(`   - "${cat.name}"  (id: ${cat.id})`);
        }
      } else {
        console.log('   (no categories in this group)');
      }
      console.log('');
    }

    // --- Current month's budget vs. actuals, via getBudgetMonth ---
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    console.log(`\n=== Budget Month: ${monthStr} ===\n`);
    const budgetMonth = await api.getBudgetMonth(monthStr);

    console.log(`Total budgeted: ${fmt(toDollars(budgetMonth.totalBudgeted))}`);
    console.log(`Total spent:    ${fmt(toDollars(budgetMonth.totalSpent))}`);
    console.log(`Total income:   ${fmt(toDollars(budgetMonth.totalIncome))}`);
    console.log('');

    for (const group of budgetMonth.categoryGroups) {
      console.log(`GROUP: "${group.name}"`);
      if (group.categories) {
        for (const cat of group.categories) {
          const budgeted = fmt(toDollars(cat.budgeted));
          const spent = fmt(toDollars(cat.spent));
          const balance = fmt(toDollars(cat.balance));
          console.log(`   - "${cat.name}"   budgeted: ${budgeted}   spent: ${spent}   balance: ${balance}`);
        }
      }
      console.log('');
    }

    console.log('=== Done. No changes were made to your budget. ===');
  } finally {
    await api.shutdown();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
