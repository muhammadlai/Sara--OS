# W2 — Discovery + Research

**Newly implemented in this repository. Not recovered from commit b1a6f79.**

| File | Role |
|------|------|
| `research.mjs` | Jina Reader/Search research; stage `researched` only on success |
| `discovery.mjs` | Query → real hits → dedupe → optional signal store (dry-run default) |
| `ledger.mjs` | `RESEARCH_LOGGED` / `RESEARCH_FAILED` / `DISCOVERY_SOURCE` / `SIGNALS_UPDATED` |
| `scoring.mjs` | W1 ICP feed; manual notes stay `verified: false` |
| `cli.mjs` | CLI |
| `test-research.mjs` | Loopback HTTP tests |

```bash
export JINA_API_KEY=...          # never commit
node worker/cli.mjs jina-health  # CONNECTED only after a real 2xx
node worker/cli.mjs research --url https://example.com --lead acme
node worker/cli.mjs discover --query "fleet buyers UAE"
npm run test:worker
```

## W4 Reply Intelligence

```bash
node worker/cli.mjs classify --text "Please unsubscribe"
node worker/cli.mjs replies
```

Without `GMAIL_ADAPTER_URL` or an injected inbox, check returns `REPLY_CHECK_FAILED`.
Without `NOTIFY_WEBHOOK_URL`, important replies log `NOTIFICATION_FAILED`.
Classifier method is `rules` — not an AI model.

## W5 Outreach

```bash
node worker/cli.mjs prepare --lead acme --channel email
node worker/cli.mjs send --lead acme --fingerprint <fp>
```

Unconfigured Email = `ADAPTER_UNAVAILABLE`. Teams without `TEAMS_ACCESS_TOKEN` = `NOT_AUTHORIZED`. LinkedIn without an official API = `MANUAL_ASSIST_REQUIRED` (never `OUTREACH_SENT`).

## W1 workflows

```bash
node worker/cli.mjs workflows
node worker/cli.mjs workflow aca_medicare --lead acme
```

Profiles constrain drafts (roofing / ACA-Medicare). They never mark mail sent.

## W6 Daily Autonomous Worker

Orchestrates existing W1–W5 modules. Does not duplicate their logic.

```bash
node worker/cli.mjs worker run
node worker/cli.mjs worker status
node worker/cli.mjs worker report
node worker/cli.mjs worker dry-run    # NEVER sends
```

Schedule: `WORKER_TZ` (default UTC), `WORKER_HOUR` / `WORKER_MINUTE` (default 10:00). Persistent run IDs live under `$OPENCLAW_HOME/worker/runs`. Duplicate same-day runs are skipped. Stale locks are recovered as `FAILED` (`stale_lock_recovered`). Confirmed sends require provider `message_id`.
