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
node worker/cli.mjs research --url https://example.com --lead acme
node worker/cli.mjs discover --query "fleet buyers UAE"
npm run test:worker

## W4 Reply Intelligence

```bash
node worker/cli.mjs classify --text "Please unsubscribe"
node worker/cli.mjs replies
```

Without `GMAIL_ADAPTER_URL` or an injected inbox, check returns `REPLY_CHECK_FAILED`.
Without `NOTIFY_WEBHOOK_URL`, important replies log `NOTIFICATION_FAILED`.
Classifier method is `rules` — not an AI model.
```
