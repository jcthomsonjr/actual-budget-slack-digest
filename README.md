# actual-budget-slack-digest

A self-hosted weekly budget digest that pulls data from [Actual Budget](https://actualbudget.org/) and posts a formatted summary to a Slack channel every Sunday morning.

---

## What it does

Connects to a self-hosted Actual Budget server, pulls the current month's budgeted vs. actual spend by category, and posts a Slack message with one table per category group. Runs automatically every Sunday at 8:00 AM Pacific time as a Docker container.

**What it shows:**
- Month-to-date spend vs. budgeted amount, per category
- One table per category group (using whatever groups you have in Actual — no hardcoded category names)
- Over-budget categories flagged with 🔴 and bold text (only for categories that have a real budget target set — categories with $0 budgeted are shown without a flag)
- Categories with no spend this month are hidden to keep the message clean

**What it doesn't do:**
- No pro-rating or "pace" projections — just real numbers, accumulating through the month
- No judgment calls — visibility only
- No fixed cost or savings special-casing — whatever's in Actual is what gets shown

**Month-boundary behavior:**
On the first Sunday of a new month, if that Sunday falls on day 6 or earlier, the digest shows both last month's final numbers and the current month's early spend. If it falls on day 7, last month's final Sunday already gave a near-complete close-out, so only the current month is shown.

---

## Requirements

- Self-hosted [Actual Budget](https://actualbudget.org/) instance (reachable by the container at runtime)
- A Slack workspace with an [incoming webhook](https://api.slack.com/messaging/webhooks) configured
- Docker (tested on Docker via snap on Ubuntu)
- Portainer for deployment (optional but recommended)

---

## Setup

### 1. Create a Slack incoming webhook

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Enable **Incoming Webhooks**
3. Add to your target channel
4. Copy the webhook URL — you'll need it as an environment variable

### 2. Deploy with Portainer

In Portainer: **Stacks → Add stack → Repository**

- **Repository URL:** `https://github.com/jcthomsonjr/actual-budget-slack-digest`
- **Compose path:** `docker-compose.yml`

Set these environment variables in Portainer's stack UI (never hardcode them):

| Variable | Description |
|---|---|
| `ACTUAL_SERVER_URL` | URL of your Actual Budget server, e.g. `https://budget.example.com` |
| `ACTUAL_PASSWORD` | Your Actual server login password |
| `ACTUAL_SYNC_ID` | The sync ID of your budget file (Settings → Advanced in the Actual UI) |
| `SLACK_WEBHOOK_URL` | The incoming webhook URL from step 1 |

Deploy the stack. The container will start, log its next scheduled run, and post every Sunday at 8:00 AM Pacific.

### 3. Manual test run

To trigger the digest immediately without waiting for Sunday, use Portainer's container console (or `docker exec`):

```bash
node scripts/weekly-digest.js
```

This bypasses the scheduler and runs the digest once. Useful for confirming everything works after initial deploy or after changes.

---

## Project structure

```
├── Dockerfile              # Node 24 slim image, non-root user, deps baked in
├── docker-compose.yml      # Portainer-ready stack definition
├── package.json
└── scripts/
    ├── scheduler.js        # Container entrypoint — fires digest every Sunday 8am PT
    ├── weekly-digest.js    # The digest logic — also runnable directly for manual tests
    └── diagnostic.js       # Read-only helper: prints your real Actual category structure
```

---

## Category exclusions

Two groups are always excluded from the digest:

- Any group with `is_income: true` in Actual (typically your Income group)
- The group literally named **"Ignore"** — a deliberate junk-drawer convention

Everything else is included as-is, using Actual's own category/group structure. If you use a different name for your junk-drawer group, update `EXCLUDED_GROUP_NAMES` in `weekly-digest.js`.

---

## Data access

This tool uses the official [`@actual-app/api`](https://www.npmjs.com/package/@actual-app/api) npm package rather than reading Actual's SQLite database directly. Actual's database uses a CRDT-based sync format (`messages_binary`) that isn't a simple relational schema — the official API package handles all the sync and reconciliation logic, so we don't have to.

The API package downloads a local copy of your budget (into the `actual-digest-cache` Docker volume) and syncs only deltas on subsequent runs.

---

## Secrets

No secrets are stored in this repository. All four sensitive values (`ACTUAL_PASSWORD`, `SLACK_WEBHOOK_URL`, `ACTUAL_SYNC_ID`, `ACTUAL_SERVER_URL`) are passed as environment variables at runtime via Portainer's stack configuration. The `docker-compose.yml` references them as `${VAR_NAME}` placeholders only.

---

## Timezone

The container runs with `TZ=America/Los_Angeles`. The cron expression `0 8 * * 0` (8:00 AM Sunday) resolves to Pacific time. To change the timezone or schedule, update `TZ` in `docker-compose.yml` and `SCHEDULE` in `scripts/scheduler.js`.
