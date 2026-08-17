#!/usr/bin/env python3
"""
Mine Golden Segments — Layer B

Reads ./parsed/<customer_hash>.jsonl files, extracts high-conversion segments
in two passes:

  Pass 1 (keyword): sliding window 6-20 turns, tagged by signals
                    (deal_close / objection_resolved / dunning_recovered /
                     relationship_warmup / cross_sell)
  Pass 2 (LLM):     Haiku scores each candidate 1-5 + extracts rationale
                    Drops < 3

Output:
  ./golden/<segment_id>.yaml — ready for KB sales_playbook import after
                                manual review.

Usage:
    export ANTHROPIC_API_KEY=...
    python mine-golden-segments.py \
        --parsed ./parsed \
        --output ./golden \
        --min-score 3

Cost model:
    ~200 candidate segments per 50 customers
    ~$0.001 per segment (Haiku, ~1500 in / ~300 out)
    ≈ $0.20 per 50-customer delivery
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

import yaml
from anthropic import Anthropic

MODEL = "claude-haiku-4-5-20251001"

# Keyword signals — case-insensitive, includes EN + ZH + ES tokens
SIGNALS: dict[str, tuple[re.Pattern[str], ...]] = {
    "deal_close": (
        re.compile(r"\b(PO|purchase order|payment|transfer|confirm(ed)?|deposit|TT|wire)\b", re.I),
        re.compile(r"(打款|付款|订了|订单确认|下单|转账)"),
        re.compile(r"(transferi|pagar|orden)", re.I),
    ),
    "objection_resolved": (
        re.compile(r"\b(expensive|too pricey|competitor|think about it|cheaper|discount)\b", re.I),
        re.compile(r"(太贵|便宜|对手|考虑|降价)"),
        re.compile(r"(caro|competidor|descuento)", re.I),
    ),
    "dunning_recovered": (
        re.compile(r"\b(any update|still there|follow ?up|reminder)\b", re.I),
        re.compile(r"(在吗|跟进|提醒|有空)"),
    ),
    "cross_sell": (
        re.compile(r"\b(new SKU|another product|also need|add to order)\b", re.I),
        re.compile(r"(新品|再来|加单|另外要)"),
    ),
}


@dataclass(frozen=True)
class Turn:
    customer_hash: str
    session_id: str
    ts: str
    sender: str
    text: str
    media: str | None = None


@dataclass
class Candidate:
    customer_hash: str
    tag: str
    start_idx: int
    end_idx: int
    turns: list[Turn] = field(default_factory=list)


def load_turns(jsonl_path: Path) -> list[Turn]:
    out: list[Turn] = []
    with jsonl_path.open(encoding="utf-8") as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            out.append(
                Turn(
                    customer_hash=d["customer_hash"],
                    session_id=d.get("session_id", ""),
                    ts=d["ts"],
                    sender=d["sender"],
                    text=d["text"],
                    media=d.get("media"),
                )
            )
    return out


def match_signal(text: str) -> str | None:
    for tag, patterns in SIGNALS.items():
        if any(p.search(text) for p in patterns):
            return tag
    return None


def mine_candidates(turns: list[Turn], window: int = 10) -> list[Candidate]:
    """Sliding window: when a signal fires, capture window/2 before + window/2 after."""
    half = window // 2
    seen: set[tuple[int, int]] = set()
    out: list[Candidate] = []
    for i, turn in enumerate(turns):
        tag = match_signal(turn.text)
        if not tag:
            continue
        # For dunning, only count if "me" sent it (we're chasing)
        if tag == "dunning_recovered" and turn.sender != "me":
            continue
        start = max(0, i - half)
        end = min(len(turns), i + half + 1)
        key = (start, end)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            Candidate(
                customer_hash=turn.customer_hash,
                tag=tag,
                start_idx=start,
                end_idx=end,
                turns=turns[start:end],
            )
        )
    # relationship_warmup: first 8 turns of each customer's first session
    if turns:
        first_session = turns[0].session_id
        first_block = [t for t in turns if t.session_id == first_session][:8]
        if len(first_block) >= 4:
            out.append(
                Candidate(
                    customer_hash=turns[0].customer_hash,
                    tag="relationship_warmup",
                    start_idx=0,
                    end_idx=len(first_block),
                    turns=first_block,
                )
            )
    return out


SYSTEM_PROMPT = """You are a B2B sales-coaching analyst. You will receive one
candidate conversation segment between a salesperson ("me") and a customer,
already tagged with a hypothesised pattern (deal_close / objection_resolved /
dunning_recovered / relationship_warmup / cross_sell).

Evaluate the segment STRICTLY:

- Score 1-5 on real business teaching value (5 = clearly successful, replicable
  tactical move; 1 = noise, off-topic, or accidental).
- A segment is worth 4+ ONLY if you can name a concrete tactical move ("me"
  did X and it worked) — not just "they talked about a deal".
- If the tag is wrong (signal triggered on a false positive), set
  retag to the correct tag or null. Otherwise echo the input tag.

Output STRICT YAML (no markdown fences):

score: int           # 1-5
retag: str | null    # corrected tag, or null = keep input tag
key_moves: list[str] # 1-3 concrete tactical moves (empty if score<3)
outcome: str         # one sentence
analyst_note: str    # one sentence: why this works (or why it doesn't)
"""


def format_segment_for_llm(c: Candidate) -> str:
    lines = [f"input_tag: {c.tag}", f"customer_hash: {c.customer_hash}", "", "TURNS:"]
    for t in c.turns:
        prefix = "ME" if t.sender == "me" else "CUSTOMER"
        lines.append(f"[{t.ts}] [{prefix}] {t.text}")
    return "\n".join(lines)


def score_segment(client: Anthropic, c: Candidate) -> dict:
    msg = client.messages.create(
        model=MODEL,
        max_tokens=600,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": format_segment_for_llm(c)}],
    )
    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    return yaml.safe_load(raw)


def emit_segment(c: Candidate, scored: dict, out_dir: Path) -> Path:
    final_tag = scored.get("retag") or c.tag
    segment_id = f"gold-{c.turns[0].ts[:10]}-{final_tag}-{uuid.uuid4().hex[:6]}"
    body = {
        "segment_id": segment_id,
        "tags": [final_tag],
        "customer_hash": c.customer_hash,
        "turn_count": len(c.turns),
        "score": scored.get("score"),
        "key_moves": scored.get("key_moves") or [],
        "outcome": scored.get("outcome"),
        "analyst_note": scored.get("analyst_note"),
        "_human_reviewed": False,
        "turns": [
            {"ts": t.ts, "sender": t.sender, "text": t.text, **({"media": t.media} if t.media else {})}
            for t in c.turns
        ],
    }
    path = out_dir / f"{segment_id}.yaml"
    path.write_text(yaml.safe_dump(body, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--min-score", type=int, default=3)
    ap.add_argument("--window", type=int, default=10)
    ap.add_argument("--dry-run", action="store_true", help="Skip LLM, emit candidates only")
    args = ap.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    candidates: list[Candidate] = []
    for jsonl in sorted(args.parsed.glob("*.jsonl")):
        turns = load_turns(jsonl)
        cands = mine_candidates(turns, window=args.window)
        candidates.extend(cands)
        print(f"[mine] {jsonl.stem}: {len(turns)} turns -> {len(cands)} candidates")

    print(f"\nTotal candidates: {len(candidates)}")
    if args.dry_run:
        print("[dry-run] skipping LLM scoring")
        return

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")
    client = Anthropic()

    kept = 0
    for c in candidates:
        try:
            scored = score_segment(client, c)
        except Exception as e:
            print(f"[err] {c.customer_hash} {c.tag}: {e}")
            continue
        if (scored.get("score") or 0) < args.min_score:
            continue
        path = emit_segment(c, scored, args.output)
        kept += 1
        print(f"[ok]  score={scored.get('score')} tag={scored.get('retag') or c.tag} -> {path.name}")

    print(f"\nKept {kept}/{len(candidates)} segments at score >= {args.min_score}.")
    print(f"Output: {args.output}")
    print("Next: manual review pass — set _human_reviewed: true after auditing.")


if __name__ == "__main__":
    main()
