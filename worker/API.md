# API dependency matrix — AITZAZ AI 2070

Honest inventory of **this repository**. `CONNECTED` is never claimed unless a real health/auth check succeeds.

| Module | Provider | Env / config | Idle status (no live check) | Health implemented | Send / write rule |
|--------|----------|--------------|-----------------------------|--------------------|-------------------|
| **W1** | none (local ledger + scoring + workflows) | `$OPENCLAW_HOME/worker` | local only | n/a | never sends |
| **W2** | Jina Search `https://s.jina.ai` + Reader `https://r.jina.ai` | `JINA_API_KEY` (required). Optional `JINA_SEARCH_BASE`, `JINA_READER_BASE`, `JINA_TIMEOUT_MS` | `NOT_CONFIGURED` if key missing | **yes** — `node worker/cli.mjs jina-health` | no outbound mail; research only |
| **W3** | Gmail OAuth / gws | **not in this repo** | `NOT_AUTHORIZED` | no | no OAuth send |
| **W4 inbox** | authorized HTTP inbox | `GMAIL_ADAPTER_URL` or injected `listInbox` | `NOT_CONFIGURED` / `gmail_unavailable` | later phase | read only |
| **W4 notify** | webhook | `NOTIFY_WEBHOOK_URL` or injected `send` | `adapter_not_configured` | later phase | `NOTIFICATION_SENT` only if adapter `ok` |
| **W5 email** | HTTP send adapter | `EMAIL_ADAPTER_URL` / `GMAIL_SEND_URL` | `ADAPTER_UNAVAILABLE` | later phase | approval + provider `message_id` |
| **W5 Teams** | Microsoft Graph | `TEAMS_ACCESS_TOKEN`, `TEAMS_GRAPH_BASE` (default `https://graph.microsoft.com/v1.0`) | `NOT_AUTHORIZED` | later phase | official Graph only |
| **W5 LinkedIn** | official API only | `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_ADAPTER_URL` | `MANUAL_ASSIST` | not unofficial | never browser/session hacks |
| **W6** | local scheduler | `WORKER_TZ`, `WORKER_HOUR`, `WORKER_MINUTE`, `WORKER_QUERIES` | `NEVER_RUN` until a local run exists | local only | uses W1–W5; dry-run never sends |
| **Voice** | local Voicebox REST | `VOICEBOX_BASE_URL` (default `http://127.0.0.1:17493`), `VOICEBOX_CLIENT_ID`, optional `VOICEBOX_TOKEN` | `DISCONNECTED` until `/health` | existing Voice Worker | no remote delivery without channel ack |

## This sandbox (audit time)

| Service | Observed |
|---------|----------|
| Jina | `JINA_API_KEY` **unset** → `NOT_CONFIGURED` (no live CONNECTED claim) |
| Gmail OAuth | **absent** → `NOT_AUTHORIZED` |
| Notify webhook | unset |
| Email send adapter | unset → `ADAPTER_UNAVAILABLE` |
| Teams Graph | unset → `NOT_AUTHORIZED` |
| LinkedIn official API | unset → `MANUAL_ASSIST` |
| Voicebox | not probed in this phase; default local URL |

Loopback / injected adapters in `npm test` are **TEST ADAPTER** only.
