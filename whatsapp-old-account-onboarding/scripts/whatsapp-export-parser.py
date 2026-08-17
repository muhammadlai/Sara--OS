#!/usr/bin/env python3
"""
WhatsApp Export Parser

Input:  ./exports/*.txt (WhatsApp "Export Chat" output, iOS or Android format)
Output: ./parsed/<customer_hash>.jsonl  (one conversation turn per line)

Usage:
    python whatsapp-export-parser.py \
        --input ./exports \
        --output ./parsed \
        --owner-name "Sarah" \
        --salt "<random-32-char-string>"

Design notes:
- PII redaction is one-way (sha256 with salt). Save your salt somewhere safe;
  losing it means you cannot reconcile customer_hash back to a real contact.
- Session split rule: 24h of silence = new session_id. Tune via --session-gap-hours.
- Media references (<Media omitted>, [image], [视频]) are replaced with [MEDIA:type]
  placeholders. The LLM never sees raw filenames.
"""
import argparse
import hashlib
import json
import re
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from pathlib import Path

IOS_LINE = re.compile(
    r"^\[(\d{4}[/-]\d{1,2}[/-]\d{1,2}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s+([^:]+?):\s*(.*)$"
)
ANDROID_LINE = re.compile(
    r"^(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s?[APap][Mm])?)\s+-\s+([^:]+?):\s*(.*)$"
)

PHONE_RE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
URL_RE = re.compile(r"https?://\S+")
MEDIA_RE = re.compile(
    r"<?(?:Media omitted|媒体已省略|\[图片\]|\[视频\]|\[语音\]|\[文件\]|image omitted|video omitted|audio omitted|document omitted)>?",
    re.IGNORECASE,
)


@dataclass
class Turn:
    customer_hash: str
    session_id: str
    ts: str
    sender: str  # "me" | "customer"
    text: str
    media: str | None = None


def hash_id(raw: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{raw.strip().lower()}".encode()).hexdigest()[:16]


def redact(text: str) -> tuple[str, str | None]:
    media_kind = None
    m = MEDIA_RE.search(text)
    if m:
        kind = m.group(0).lower()
        if "image" in kind or "图片" in kind:
            media_kind = "image"
        elif "video" in kind or "视频" in kind:
            media_kind = "video"
        elif "audio" in kind or "语音" in kind:
            media_kind = "audio"
        else:
            media_kind = "document"
        text = MEDIA_RE.sub(f"[MEDIA:{media_kind}]", text)
    text = PHONE_RE.sub("[PHONE]", text)
    text = EMAIL_RE.sub("[EMAIL]", text)
    text = URL_RE.sub("[URL]", text)
    return text.strip(), media_kind


def parse_timestamp(date_str: str, time_str: str) -> datetime | None:
    date_str = date_str.replace("-", "/")
    for date_fmt in ("%Y/%m/%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%d/%m/%y"):
        for time_fmt in ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I:%M%p"):
            try:
                return datetime.strptime(f"{date_str} {time_str}", f"{date_fmt} {time_fmt}")
            except ValueError:
                continue
    return None


def parse_file(path: Path, owner_name: str, salt: str, session_gap_hours: int) -> list[Turn]:
    """Each .txt is a single 1-on-1 chat. The non-owner name = customer."""
    raw_turns: list[tuple[datetime, str, str]] = []
    current: tuple[datetime, str, list[str]] | None = None

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = IOS_LINE.match(line) or ANDROID_LINE.match(line)
        if m:
            if current:
                raw_turns.append((current[0], current[1], "\n".join(current[2])))
            ts = parse_timestamp(m.group(1), m.group(2))
            if not ts:
                current = None
                continue
            current = (ts, m.group(3).strip(), [m.group(4)])
        elif current:
            current[2].append(line)
    if current:
        raw_turns.append((current[0], current[1], "\n".join(current[2])))

    senders = {s for _, s, _ in raw_turns}
    customer_name = next((s for s in senders if s != owner_name), None)
    if not customer_name:
        return []

    customer_hash = hash_id(customer_name, salt)
    out: list[Turn] = []
    last_ts: datetime | None = None
    session_start: datetime | None = None
    gap = timedelta(hours=session_gap_hours)

    for ts, sender, raw_text in raw_turns:
        if last_ts is None or ts - last_ts > gap:
            session_start = ts
        last_ts = ts
        text, media = redact(raw_text)
        if not text:
            continue
        out.append(
            Turn(
                customer_hash=customer_hash,
                session_id=f"{customer_hash}-{session_start.strftime('%Y%m%dT%H%M')}",
                ts=ts.isoformat(),
                sender="me" if sender == owner_name else "customer",
                text=text,
                media=media,
            )
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--owner-name", required=True, help="Your name as it appears in exports")
    ap.add_argument("--salt", required=True, help="Random secret for hashing customer IDs")
    ap.add_argument("--session-gap-hours", type=int, default=24)
    args = ap.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    files = sorted(args.input.glob("*.txt"))
    if not files:
        raise SystemExit(f"No .txt files found in {args.input}")

    summary: dict[str, int] = {}
    for f in files:
        turns = parse_file(f, args.owner_name, args.salt, args.session_gap_hours)
        if not turns:
            print(f"[skip] {f.name}: could not detect customer (owner-name mismatch?)")
            continue
        customer_hash = turns[0].customer_hash
        out_path = args.output / f"{customer_hash}.jsonl"
        with out_path.open("a", encoding="utf-8") as fp:
            for t in turns:
                fp.write(json.dumps(asdict(t), ensure_ascii=False) + "\n")
        summary[customer_hash] = summary.get(customer_hash, 0) + len(turns)
        print(f"[ok]  {f.name} -> {out_path.name} (+{len(turns)} turns)")

    print(f"\nDone. {len(summary)} customers, {sum(summary.values())} total turns.")


if __name__ == "__main__":
    main()
