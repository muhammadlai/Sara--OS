# Running on Kimi K2.6 (Moonshot AI)

This template works with any LLM provider that OpenClaw supports. If you run it on **Kimi K2.6** (Moonshot AI) via the **Kimi Code API key subscription**, these notes will save you hours of debugging.

## TL;DR

1. Configure Kimi auth via the interactive wizard:
   ```bash
   openclaw models auth login --provider moonshot --set-default
   ```
   Pick **Moonshot AI (Kimi K2.6)** → **Kimi Code API key (subscription)** and paste your key.

2. If you skip the wizard and edit config files directly, make sure **every `auth-profiles.json` is consistent** — see the pitfall section below.

3. Bump `agents.defaults.contextTokens` in `openclaw.json` to match your model's real window, otherwise auto-compaction will thrash.

4. Tighten `memorylake-openclaw` plugin: `topK: 3`, `searchThreshold: 0.7` — the defaults recall too aggressively for a 262K model and still cause overflow when system prompt + skill manifests are large.

---

## Pitfall 1 — Key lives in `auth-profiles.json`, not `openclaw.json`

OpenClaw stores provider API keys per-agent in:

```
~/.openclaw/agents/<agent-id>/agent/auth-profiles.json
```

This file **overrides** `openclaw.json`'s `models.providers.<name>.apiKey`. Editing `openclaw.json` alone has no effect at runtime.

For Kimi specifically there are **two** provider ids (`kimi` and `kimi-coding`) that share the same upstream plugin. Both profiles must point at the same current key, or OpenClaw's auth rotation will cycle from the good one to the stale one and emit misleading errors like:

```
HTTP 401 authentication_error: The API Key appears to be invalid or may have expired.
→ rotate_profile
→ HTTP 402: We're unable to verify your membership benefits at this time.
```

The 402 is *not* a real membership problem — it's OpenClaw retrying with a stale key in a sibling profile.

### Fix (non-interactive)

```bash
NEW_KEY="sk-kimi-..."
for agent_dir in ~/.openclaw/agents/*/agent; do
  python3 - <<PY
import json, pathlib
p = pathlib.Path("$agent_dir/auth-profiles.json")
if not p.exists(): raise SystemExit
c = json.loads(p.read_text())
for pid in ("kimi:default", "kimi-coding:default"):
  if pid in c.get("profiles", {}):
    c["profiles"][pid]["key"] = "$NEW_KEY"
p.write_text(json.dumps(c, indent=4))
print("updated", p)
PY
done
# clear stale failure state so the new key gets a fresh retry
rm -f ~/.openclaw/agents/*/agent/auth-state.json
systemctl --user restart openclaw-gateway
```

### Fix (recommended — use the wizard)

```bash
openclaw models auth login --provider moonshot --set-default
```

---

## Pitfall 2 — `contextTokens` doesn't auto-adapt to model window

`agents.defaults.contextTokens` is a **total-turn budget** (input + output) that OpenClaw writes during setup. It is **not** derived from the active model's declared `contextWindow`. Default values (often `60000`) cap the prompt budget at roughly **20K input + 40K output**, far below what Kimi K2.6 (262K) or Claude Sonnet (200K) can actually handle.

Symptom on an "oversized" system prompt (big `SKILL.md` manifest, memorylake recall, long `AGENTS.md`):

```
[context-overflow-precheck] estimatedPromptTokens=20487
promptBudgetBeforeReserve=20000 overflowTokens=487
→ auto-compaction retries 3 times, all fail (system prompt is not compressible)
```

### Fix

Set `agents.defaults.contextTokens` to roughly 75% of your model's window:

| Model | `contextWindow` | Recommended `contextTokens` |
|-------|-----------------|-----------------------------|
| Kimi K2.6 (kimi-code / k2p5) | 262,144 | **200000** |
| Claude Sonnet 4.6 | 200,000 | 160000 |
| DeepSeek V3 / R1 | 131,072 | 100000 |

Also raise `agents.defaults.compaction.reserveTokensFloor` to around `60000` so large replies don't starve.

```bash
openclaw config set agents.defaults.contextTokens 200000
openclaw config set agents.defaults.compaction.reserveTokensFloor 60000
systemctl --user restart openclaw-gateway
```

---

## Pitfall 3 — `memorylake-openclaw` recall thrashes on big models

With `autoRecall: true` (default) and no limits, memorylake injects every loosely-related memory into the turn. On Kimi K2.6 this often pushes past the effective prompt budget even when the absolute window is plenty.

Supported config keys (from `openclaw.plugin.json → configSchema`):
- `topK` (default `5`) — max memories per recall
- `searchThreshold` (default `0.3`) — min similarity score
- `autoRecall` / `autoCapture` / `autoUpload` (default `true`)
- `rerank` (default `true`)

### Recommended settings for SDR on Kimi

```json
"plugins": {
  "entries": {
    "memorylake-openclaw": {
      "config": {
        "apiKey": "sk-...",
        "projectId": "proj-...",
        "topK": 3,
        "searchThreshold": 0.7
      }
    }
  }
}
```

Stricter threshold + fewer hits → only strongly-relevant context reaches the prompt. Agents still call `memory_search` explicitly when they need deeper lookups.

---

## Pitfall 4 — Anthropic fallbacks slow everything down after a billing lapse

If your `agents.defaults.model.fallbacks` list contains a dozen `anthropic/*` entries and your Anthropic billing fails, each turn burns time walking through every Claude model (each marked `skip_candidate reason=billing`) before reaching a working DeepSeek or Kimi fallback.

### Fix

Strip `anthropic/*` from `fallbacks` while your billing issue is open:

```bash
openclaw config get agents.defaults.model.fallbacks
# edit: remove entries starting with "anthropic/"
openclaw config set agents.defaults.model.fallbacks '["deepseek/deepseek-chat","deepseek/deepseek-reasoner","kimi/kimi-code"]' --strict-json
```

Add Anthropic back after you restore billing.

---

## Pitfall 5 — OpenClaw's fallback does not switch providers on 401/402

OpenClaw's auth rotation triggers on `401` and `402` responses but only **rotates between auth profiles of the same provider** (e.g. `kimi:default → kimi-coding:default`). It does **not** escalate to a different provider in `fallbacks` for auth errors.

Consequence: if all profiles of your primary provider have stale keys, the agent fails permanently on that turn rather than falling through to DeepSeek.

### Workaround

- Keep primary provider auth fresh (see Pitfall 1).
- If you want cross-provider failover on auth errors, either remove the bad secondary profile entirely or keep only one provider in the `agents.list[].model.primary` and let DeepSeek sit in `fallbacks` for non-auth errors (e.g. rate limits).

---

## Verification

After configuring Kimi K2.6 as primary:

```bash
# check active profile
openclaw models status | grep kimi

# end-to-end turn
openclaw agent --agent <your-sdr-agent-id> \
  --session-id "kimi-check-$(date +%s)" \
  --message "Reply just: pong" \
  --timeout 60
# expected: pong
```

If you see `membership benefits` or `API Key appears invalid`, re-check Pitfall 1 first (stale sibling profile).

---

## Why this matters

Kimi K2.6 on the Kimi Code API subscription is currently one of the cheapest 262K-context models with Claude-class quality for Chinese and English agent work. The rough edges are in the OpenClaw integration layer, not in Kimi itself — all five pitfalls above were hit in production while onboarding this template onto a Kimi-primary stack. Documenting them here so you don't have to repeat the debugging.
