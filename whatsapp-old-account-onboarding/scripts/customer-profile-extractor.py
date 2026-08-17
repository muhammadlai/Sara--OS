#!/usr/bin/env python3
"""
Customer Profile Extractor

Reads ./parsed/<customer_hash>.jsonl, runs Claude Haiku in batch,
emits ./profiles/<customer_hash>.yaml ready for MemOS ingestion.

Usage:
    export ANTHROPIC_API_KEY=...
    python customer-profile-extractor.py \
        --parsed ./parsed \
        --output ./profiles \
        --min-turns 20

Cost model (Haiku 4.5, indicative):
    ~3K input tokens + ~600 output tokens per customer
    = ~$0.003 per customer
    500 customers ≈ $1.50
"""
import argparse
import json
import os
import sys
from pathlib import Path

import yaml
from anthropic import Anthropic

MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """You are a B2B sales-intelligence analyst. You will receive the
full chat history between a salesperson ("me") and one foreign-trade customer.

Extract a structured customer profile. Be CONSERVATIVE:
- If a field is not clearly evidenced by the chat, set it to null. Never guess.
- Do not invent prices, order quantities, or commitments.
- For `known_objections`, only include patterns repeated >=2 times.
- For `unfinished_commitments`, only include promises by "me" that were never
  followed up on (no later message showing delivery / closure).

Output STRICT YAML matching this schema (no markdown fences):

customer_hash: str
company: str | null
country: str | null
language_mix: list[str]          # e.g. ["en", "zh"]
relationship_days: int | null
total_turns: int
total_sessions: int
known_orders: list[{summary: str, approx_value_usd: int | null}]
preferred_payment: str | null
known_objections: list[str]
unfinished_commitments: list[str]
communication_style: str          # 1-2 sentences, factual
red_flags: list[str]              # late payers, scammers, abusive, etc.
last_interaction_summary: str
relationship_score: int           # 1-10, 10 = strongest
"""


def load_turns(jsonl_path: Path) -> list[dict]:
    turns: list[dict] = []
    with jsonl_path.open(encoding="utf-8") as fp:
        for line in fp:
            line = line.strip()
            if line:
                turns.append(json.loads(line))
    return turns


def format_chat_for_llm(turns: list[dict], max_turns: int = 400) -> str:
    """Trim very long histories: keep first 50 + last 350 turns (early context + recent state)."""
    if len(turns) > max_turns:
        turns = turns[:50] + [{"sender": "system", "ts": "", "text": "...[truncated middle]..."}] + turns[-(max_turns - 50):]
    lines = []
    sessions_seen: set[str] = set()
    for t in turns:
        sid = t.get("session_id")
        if sid and sid not in sessions_seen:
            sessions_seen.add(sid)
            lines.append(f"\n--- session {len(sessions_seen)} @ {t.get('ts', '?')} ---")
        prefix = "ME" if t["sender"] == "me" else "CUSTOMER" if t["sender"] == "customer" else "SYS"
        lines.append(f"[{prefix}] {t['text']}")
    return "\n".join(lines)


def derive_metadata(turns: list[dict]) -> dict:
    if not turns:
        return {}
    sessions = {t["session_id"] for t in turns if "session_id" in t}
    first_ts, last_ts = turns[0]["ts"], turns[-1]["ts"]
    from datetime import datetime
    try:
        d = (datetime.fromisoformat(last_ts) - datetime.fromisoformat(first_ts)).days
    except Exception:
        d = None
    return {
        "customer_hash": turns[0]["customer_hash"],
        "total_turns": len(turns),
        "total_sessions": len(sessions),
        "relationship_days": d,
    }


def extract_profile(client: Anthropic, turns: list[dict]) -> dict:
    chat = format_chat_for_llm(turns)
    meta = derive_metadata(turns)
    msg = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": (
                    f"customer_hash: {meta['customer_hash']}\n"
                    f"derived_total_turns: {meta['total_turns']}\n"
                    f"derived_total_sessions: {meta['total_sessions']}\n"
                    f"derived_relationship_days: {meta['relationship_days']}\n\n"
                    f"CHAT HISTORY:\n{chat}"
                ),
            }
        ],
    )
    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    profile = yaml.safe_load(raw)
    # ensure derived fields are authoritative
    profile.update(meta)
    return profile


# TODO: USER CONTRIBUTION — define what disqualifies a customer from auto-onboarding.
# This is the gatekeeper before MemOS ingestion. Tradeoffs:
#   - Too strict  -> good customers fall through, manual review backlog grows
#   - Too lenient -> Agent inherits bad context, may repeat past mistakes
# Consider: red_flags presence, relationship_score threshold, language mismatch,
# total_turns floor, suspicious unfinished_commitments, etc.
def should_auto_onboard(profile: dict) -> tuple[bool, str]:
    """Strict gate for legacy-account first import.
    Tuned for: maximize trust in auto-onboarded set, accept ~30-40% manual review."""
    if profile.get("red_flags"):
        return False, "red flags: manual review"
    score = profile.get("relationship_score") or 0
    if score < 6:
        return False, f"relationship_score {score} < 6"
    if len(profile.get("unfinished_commitments") or []) > 2:
        return False, "too many open commitments"
    return True, "ok"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--min-turns", type=int, default=20)
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    client = Anthropic()
    args.output.mkdir(parents=True, exist_ok=True)
    review_queue = args.output / "_manual_review.txt"

    for jsonl in sorted(args.parsed.glob("*.jsonl")):
        turns = load_turns(jsonl)
        if len(turns) < args.min_turns:
            print(f"[skip] {jsonl.stem}: {len(turns)} turns < {args.min_turns}")
            continue
        try:
            profile = extract_profile(client, turns)
        except Exception as e:
            print(f"[err]  {jsonl.stem}: {e}")
            continue

        allow, reason = should_auto_onboard(profile)
        profile["_auto_onboard"] = allow
        profile["_gate_reason"] = reason

        out = args.output / f"{jsonl.stem}.yaml"
        out.write_text(yaml.safe_dump(profile, allow_unicode=True, sort_keys=False), encoding="utf-8")
        print(f"[ok]  {jsonl.stem} -> {out.name} (auto_onboard={allow})")

        if not allow:
            with review_queue.open("a", encoding="utf-8") as fp:
                fp.write(f"{jsonl.stem}\t{reason}\n")


if __name__ == "__main__":
    main()
