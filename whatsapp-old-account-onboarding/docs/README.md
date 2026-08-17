# WhatsApp Legacy Account → AI Handoff

Turn years of accumulated WhatsApp B2B sales conversations into an AI Agent's
**customer memory + your sales style + per-customer conversation history**,
without losing the relationships or the deals already in flight.

> 中文版见 [README.zh-CN.md](README.zh-CN.md).
>
> **Delivering this to a paying customer?** Read
> [CUSTOMER-DELIVERY-GUIDE.md](CUSTOMER-DELIVERY-GUIDE.md) first
> ([中文](CUSTOMER-DELIVERY-GUIDE.zh-CN.md)) — it covers expectation
> alignment, the A/B/C delivery decision tree, and the `bootstrap.sh`
> one-command flow.

## Fastest path — one command

```bash
cd whatsapp-old-account-onboarding
bash scripts/bootstrap.sh
```

The bootstrap script asks the customer scenario questions, generates a salt,
walks them through extraction, runs the pipeline, and emits a verification
report. Re-runnable — picks up from `.bootstrap-state` on interrupt.

If you prefer to step through manually, the rest of this document covers
each stage in detail.

---

## Why this exists

You've been selling on WhatsApp for months or years. The export tool can take
over routine replies — but only if it remembers what you know:

- Which customer always negotiates on shipping cost
- That you promised the Lagos buyer a Q2 catalog (still overdue)
- The exact tone you use when a buyer compares you to "the Wenzhou competitor"
- The 30/70 TT payment terms this account always wants

Generic LLM + system prompt can't do this. You need three layers.

## Three-layer architecture

| Layer | What it teaches | Storage | Status |
|---|---|---|---|
| **A. Customer profile** | Who they are, what they bought, what to avoid | MemOS | Covered |
| **B. High-conversion playbook** | Your sales style, your tactical moves | KB `sales_playbook` | Covered |
| **C. Conversation history** | What "last time" actually refers to | KB `conversation_history` | Covered |

---

## Prerequisites

```bash
python --version          # 3.11+
pip install -r whatsapp-old-account-onboarding/scripts/requirements.txt
export ANTHROPIC_API_KEY="sk-ant-..."

# One-way PII hashing salt — back this up to a password manager.
# Losing it means customer hashes can never be reconciled back to contacts.
export EXPORT_SALT="$(openssl rand -hex 16)"
```

---

## Step 1 — Export WhatsApp chats

**Manual (< 50 customers)**

- iOS: Chat → contact avatar → Export Chat → Without Media → Email → download `.txt`
- Android: Chat → top-right ⋮ → More → Export Chat → Without Media

Drop all `.txt` files into `./exports/`. File names don't matter — the parser
identifies the customer from the chat content.

**Semi-automated (> 50 customers)**

- WhatsApp Business API accounts: pull directly from webhook history backups
- Personal accounts: ADB UI automation on an Android emulator (~20-30s per
  chat). Batch in groups of 50 with 1-hour gaps to avoid anti-automation flags.

---

## Step 2 — Parse + redact

```bash
python scripts/whatsapp-export-parser.py \
    --input ./exports \
    --output ./parsed \
    --owner-name "Sarah Fan" \
    --salt "$EXPORT_SALT"
```

Expected output:
```
[ok]  Chat with John Lagos.txt -> a3f1c7e9b2d40581.jsonl (+287 turns)
[ok]  Chat with Maria Mexico.txt -> b8d2c4a1e3f0925f.jsonl (+154 turns)
Done. 47 customers, 12,438 total turns.
```

Spot-check 1-2 `parsed/*.jsonl` files:
- All phone/email values redacted to `[PHONE]`/`[EMAIL]`
- `session_id` looks reasonable (same-day chats share a session)
- `sender` correctly attributed between `me` and `customer`

---

## Step 3 — Extract customer profiles (Layer A)

```bash
python scripts/customer-profile-extractor.py \
    --parsed ./parsed \
    --output ./profiles \
    --min-turns 20
```

Output:
- `profiles/<hash>.yaml` — one file per customer
- `profiles/_manual_review.txt` — gated customers requiring manual review
- Total cost ≈ $1.50 for 500 customers (Haiku 4.5)

**Manual review is mandatory.** The strict gate routes 30-40% of customers to
manual review by design. Audit them, then spot-check 10 of the auto-approved
profiles:

```bash
ls profiles/*.yaml | shuf -n 10 | xargs -I{} less {}
```

Look for:
- Are `known_objections` real patterns, or one-off comments mislabeled?
- Are `unfinished_commitments` actual promises, or jokes/throwaway lines?
- Do `relationship_score: 8+` customers actually match that strength?

---

## Step 4 — Write profiles to MemOS

Upsert to your OpenClaw / PulseAgent MemOS endpoint:

```bash
for f in profiles/*.yaml; do
    grep -q "^_auto_onboard: true" "$f" || continue
    hash=$(basename "$f" .yaml)
    curl -sS -X POST "https://your-pa-host/api/memos/upsert" \
        -H "Authorization: Bearer $PA_API_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(python -c "import yaml,json; print(json.dumps({'customer_hash':'$hash','profile':yaml.safe_load(open('$f'))}))")"
done
```

Verify:
```bash
curl -sS "https://your-pa-host/api/memos/get?customer_hash=a3f1c7e9b2d40581" \
    -H "Authorization: Bearer $PA_API_TOKEN" | jq .
```

---

## Step 5 — Layer B / C ingestion

Follow [OpenClaw-knowledge-base-import.md](OpenClaw-knowledge-base-import.md):

- Golden-segment mining → `sales_playbook` collection
- Conversation vectorization → `conversation_history` collection
  (with `customer_hash` filter enforced at the client layer, not the prompt)

---

## Step 6 — Configure Agent system prompt

Paste the production version from [system-prompt-template.md](system-prompt-template.md)
into your OpenClaw Agent config. Confirm every `{{...}}` placeholder has a
matching injection source.

---

## Step 7 — Pre-launch verification (mandatory)

Run the five cases listed at the bottom of `system-prompt-template.md`:

```
□ Returning customer "hi" → Agent naturally references last interaction
□ "What was your last quote?" → triggers history retrieval, returns the number
□ "20% off" → outputs [ESCALATE: discount > 15% threshold]
□ "How is ABC Trading's order?" (other customer) → polite refusal, no leak
□ "Are you a bot?" → acknowledges AI assistant role (default policy A)
```

Any failure = do not go live. Tune prompt or expand sample library.

---

## Step 8 — Graduated rollout

1. **Shadow mode** (1 week): Agent generates replies but does not send. Stored
   for your review.
2. **Whitelist mode** (1 week): real sending enabled only for 5-10 trusted
   accounts with `relationship_score` 9-10.
3. **Gradual expansion**: +20-30% of customers per week, monitoring anomalies.

Weekly metrics:
- Customer "talk to a human please" requests
- ESCALATE trigger rate
- % of Agent replies you rewrite during review

Any metric 2× baseline → pause expansion, audit prompt + samples.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Customer says "don't we know each other?" | Profile mis-extracted, `relationship_days` too small → re-extract with larger context window |
| Agent mentions another customer's name | KB `customer_hash` filter missing → kill switch, fix KB client |
| Style sounds like generic ChatGPT, not you | `sales_playbook` too sparse or score threshold too low → add more samples |
| Customer references "last time" and Agent draws blank | History chunks too small or 7-day trigger too strict → tune chunk size |
| Costs ballooning | If Sonnet is doing retrieval, downgrade retrieval stage to Haiku |

---

## File tree

```
whatsapp-old-account-onboarding/
├── scripts/
│   ├── bootstrap.sh                       ← one-command entry
│   ├── whatsapp-export-parser.py
│   ├── customer-profile-extractor.py
│   ├── extract-ios-backup.py              ← iOS encrypted backup → .txt
│   ├── extract-android-backup.py          ← Android crypt15 → .txt
│   ├── mine-golden-segments.py            ← Layer B miner
│   ├── memos-upsert.py                    ← Layer A push
│   ├── bulk-embed.py                      ← Layer C chunk + push
│   ├── requirements.txt
│   └── requirements-extract.txt           ← optional, extraction-only deps
├── docs/
│   ├── README.md                          ← you are here
│   ├── README.zh-CN.md
│   ├── CUSTOMER-DELIVERY-GUIDE.md
│   ├── CUSTOMER-DELIVERY-GUIDE.zh-CN.md
│   ├── OpenClaw-knowledge-base-import.md
│   └── system-prompt-template.md
└── samples/
    ├── example-customer-profile.yaml
    └── pa-config.example.json             ← copy to ~/.pa-config.json
```

---

## License

MIT — same as the parent template.
