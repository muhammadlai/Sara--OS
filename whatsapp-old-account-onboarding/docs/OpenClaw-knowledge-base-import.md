# Layer B/C — Knowledge Base Ingestion SOP

Gives the Agent two capabilities: **learn your high-conversion moves**
(Layer B) and **remember what each customer said before** (Layer C).

## Data flow

```
parsed/*.jsonl ──┬── mine-golden-segments.py ── golden/*.yaml ── KB: sales_playbook
                 │
                 └── bulk-embed.py            ── vectors        ── KB: conversation_history
```

- `sales_playbook` — shared across customers and tenants. Style + tactics.
- `conversation_history` — per-customer, **strict isolation** by `customer_hash`.

---

## Layer B — `sales_playbook` (high-conversion samples)

### 1. Five segment classes, ranked by value

| Tag | Meaning | Detection signal | Value |
|---|---|---|---|
| `deal_close` | Closed deal turn | Customer reply contains PO / payment / transfer / confirm; followed by shipping discussion within 7 days | ⭐⭐⭐⭐⭐ |
| `objection_resolved` | Objection successfully neutralised | "expensive / too pricey / competitor / think about it" appears, conversation returns to order details within 3 turns | ⭐⭐⭐⭐ |
| `dunning_recovered` | Customer revived after silence | "me" sent ≥3 unanswered messages, then customer replies and eventually closes | ⭐⭐⭐⭐ |
| `relationship_warmup` | First-contact-to-first-order bridge | High-density exchange before the first order | ⭐⭐⭐ |
| `cross_sell` | Returning customer expansion | 2nd+ order with a new SKU appears | ⭐⭐⭐ |

### 2. Selection pipeline

**Automated first pass** (script, ~95% noise filtered):
- Sliding window 6-20 turns = one candidate segment
- Keyword-match against the signals above, tag accordingly
- Emit candidate JSONL

**LLM second pass** (Haiku, ~$0.001 per segment):
- Score 1-5 (business value)
- Drop anything < 3
- Extract one-sentence rationale: "why did this work?"

**Human final review** (mandatory, ~30 sec per segment):
- Mislabeled? Delete.
- Contains PII or competitor smearing? Delete.
- Style you don't want to repeat? Delete.

> ⚠️ **Do not skip the human review.** Some "successful" segments are luck,
> not technique. Bad samples pollute every tenant downstream.

### 3. KB entry format (YAML, one file per segment)

```yaml
segment_id: gold-2025-08-04-deal-close-001
tags: [deal_close]
context: "Nigeria auto-parts buyer, 3rd quote, balked on price twice"
turn_count: 8
preceded_by: "Customer sent a competitor quote screenshot"
key_moves:
  - "Did not drop unit price; first confirmed order volume bracket"
  - "Reframed comparison from unit price to landed cost"
  - "Anchored: 'we did the same config landed cost X for ABC Trading'"
outcome: "Customer agreed to 30% TT deposit"
score: 5
analyst_note: "Re-anchor on landed cost to escape unit-price red ocean"
turns:
  - sender: customer
    text: "Your price is much higher than [COMPETITOR]"
  - sender: me
    text: "I understand. Let's compare landed cost..."
  # ... full segment
```

### 4. Runtime retrieval (in the Agent loop)

```python
# Pseudo — OpenClaw Knowledge Base API
similar = kb.query(
    collection="sales_playbook",
    query=current_conversation_context_summary,  # NOT the raw last customer message
    top_k=3,
    filters={"score": {"$gte": 4}},
)
fewshot_block = render_fewshot(similar)  # injected into the system prompt
```

**Critical**: query with a *summary* of the current situation, not the
customer's raw last message. If the customer says "too expensive", direct
embedding of that phrase retrieves every price-haggling segment — not the
ones most similar to the current relationship and stage.

---

## Layer C — `conversation_history` (full conversation vector index)

### 1. Ingestion

```bash
python scripts/bulk-embed.py \
    --parsed ./parsed \
    --collection conversation_history \
    --chunk-size 8 \
    --chunk-overlap 2
```

- chunk = 8 turns (covers one complete micro-topic)
- overlap = 2 turns (avoids context loss at topic boundaries)
- mandatory metadata: `customer_hash`, `session_id`, `ts_start`, `ts_end`

### 2. Retrieval rules

| Trigger | Behavior |
|---|---|
| Customer says "last time / previously / before" | Force-retrieve top-3 from this customer's history |
| > 7 days since last interaction | Retrieve summaries of the last 2 sessions |
| Customer asks product/price detail | Retrieve this customer's relevant chunks + anonymised summaries from same-country peers |
| Default short chat flow | Skip retrieval — save latency |

### 3. Isolation boundary (must read)

```python
# Hard filter, never optional
results = kb.query(
    collection="conversation_history",
    query=q,
    filters={"customer_hash": {"$eq": current_customer_hash}},  # never absent
    top_k=5,
)
```

- Cross-customer retrieval is only allowed against `sales_playbook` (already
  de-identified).
- Any reference must be stripped of company names, order numbers, and
  specific amounts before reaching the model.

---

## Post-ingestion validation

- [ ] `sales_playbook` has at least 30 segments, each tag ≥ 5
- [ ] Spot-check 10 segments, zero PII leaks
- [ ] `conversation_history` total chunks ≈ total turns / (chunk_size - chunk_overlap) ± 5%
- [ ] Cross-customer leak test: query with customer A's hash → no customer B chunks
- [ ] Latency: top-3 retrieval < 200ms (ChromaDB default backend should clear this)

---

## Failure modes

| Symptom | Root cause | Fix |
|---|---|---|
| Agent replies with another customer's order number | Missing `customer_hash` filter in `conversation_history` | Enforce filter injection at KB client layer |
| Agent's tone suddenly off | `sales_playbook` top_k too large | Drop to 3, add score floor |
| Agent parrots historical phrasing verbatim | Few-shot injection too heavy, model treats it as template | Add "use as STYLE REFERENCE ONLY, do not copy phrasing" to prompt |
| "What was your last quote?" → Agent draws blank | Chunks too small, price discussions split across chunks | Increase chunk_size to 12, rebuild index |
