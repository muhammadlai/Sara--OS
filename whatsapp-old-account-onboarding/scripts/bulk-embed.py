#!/usr/bin/env python3
"""
Bulk Embed — Layer C upload

Chunks ./parsed/<customer_hash>.jsonl into KB-ready records and uploads to
PulseAgent / OpenClaw Knowledge Base `conversation_history` collection.

By design we DO NOT compute embeddings locally — the PulseAgent KB backend
owns embedding model selection so all customers stay consistent. This script
just slices conversation turns into chunks + metadata.

Two output modes:
  --upload   POST each chunk to PA `/api/kb/upsert` endpoint
  (default)  Emit a single ./layer-c-chunks.jsonl for offline import

Chunk schema (per record):
    {
      "collection":    "conversation_history",
      "customer_hash": "<16-hex>",         <-- isolation key
      "session_id":    "<hash>-<isoTs>",
      "chunk_id":      "<hash>-c0042",
      "ts_start":      "ISO timestamp",
      "ts_end":        "ISO timestamp",
      "turn_count":    8,
      "text":          "[me] ...\n[customer] ...\n..."
    }

Config sources mirror memos-upsert.py (pa-config.json / env vars / CLI).

Usage:
    python bulk-embed.py --parsed ./parsed                  # emit JSONL
    python bulk-embed.py --parsed ./parsed --upload         # push to PA
    python bulk-embed.py --parsed ./parsed --chunk-size 12  # larger chunks
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable
from urllib import error, request


@dataclass
class Chunk:
    collection: str
    customer_hash: str
    session_id: str
    chunk_id: str
    ts_start: str
    ts_end: str
    turn_count: int
    text: str


def load_turns(jsonl_path: Path) -> list[dict]:
    turns: list[dict] = []
    with jsonl_path.open(encoding="utf-8") as fp:
        for line in fp:
            line = line.strip()
            if line:
                turns.append(json.loads(line))
    return turns


def chunk_turns(
    turns: list[dict], chunk_size: int, overlap: int
) -> Iterable[Chunk]:
    if chunk_size <= overlap:
        raise ValueError("chunk_size must exceed overlap")
    if not turns:
        return
    customer_hash = turns[0]["customer_hash"]
    step = chunk_size - overlap
    idx = 0
    chunk_num = 0
    while idx < len(turns):
        window = turns[idx : idx + chunk_size]
        if not window:
            break
        ts_start, ts_end = window[0]["ts"], window[-1]["ts"]
        text = "\n".join(f"[{t['sender']}] {t['text']}" for t in window)
        yield Chunk(
            collection="conversation_history",
            customer_hash=customer_hash,
            session_id=window[0].get("session_id", ""),
            chunk_id=f"{customer_hash}-c{chunk_num:04d}",
            ts_start=ts_start,
            ts_end=ts_end,
            turn_count=len(window),
            text=text,
        )
        chunk_num += 1
        if idx + chunk_size >= len(turns):
            break
        idx += step


def load_config(args: argparse.Namespace) -> dict[str, str]:
    cfg: dict[str, str] = {}
    for path in (Path.cwd() / "pa-config.json", Path.home() / ".pa-config.json"):
        if path.is_file():
            cfg.update(json.loads(path.read_text(encoding="utf-8")))
            break
    for key in ("endpoint", "token", "tenant"):
        env = os.environ.get(f"PA_{key.upper()}")
        if env:
            cfg[key] = env
        cli = getattr(args, key, None)
        if cli:
            cfg[key] = cli
    return cfg


def upload_chunk(cfg: dict[str, str], chunk: Chunk) -> tuple[int, str]:
    url = f"{cfg['endpoint'].rstrip('/')}/api/kb/upsert"
    payload = json.dumps({"tenant": cfg.get("tenant"), **asdict(chunk)}).encode("utf-8")
    req = request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg['token']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", type=Path, required=True)
    ap.add_argument("--output", type=Path, default=Path("./layer-c-chunks.jsonl"))
    ap.add_argument("--chunk-size", type=int, default=8)
    ap.add_argument("--chunk-overlap", type=int, default=2)
    ap.add_argument("--upload", action="store_true", help="POST chunks to PA KB endpoint")
    ap.add_argument("--endpoint")
    ap.add_argument("--token")
    ap.add_argument("--tenant")
    args = ap.parse_args()

    cfg = load_config(args)
    if args.upload:
        missing = [k for k in ("endpoint", "token") if k not in cfg]
        if missing:
            sys.exit(f"--upload requires config keys: {missing}. See script docstring.")

    total_chunks = 0
    total_uploads_ok = 0
    total_uploads_err = 0

    if not args.upload:
        out_fp = args.output.open("w", encoding="utf-8")
    else:
        out_fp = None

    try:
        for jsonl in sorted(args.parsed.glob("*.jsonl")):
            turns = load_turns(jsonl)
            chunks = list(chunk_turns(turns, args.chunk_size, args.chunk_overlap))
            total_chunks += len(chunks)
            print(f"[chunk] {jsonl.stem}: {len(turns)} turns -> {len(chunks)} chunks")

            for c in chunks:
                if out_fp:
                    out_fp.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")
                else:
                    code, body = upload_chunk(cfg, c)
                    if 200 <= code < 300:
                        total_uploads_ok += 1
                    else:
                        total_uploads_err += 1
                        snippet = body[:120].replace("\n", " ")
                        print(f"[err] {c.chunk_id} -> HTTP {code}: {snippet}")
    finally:
        if out_fp:
            out_fp.close()

    if args.upload:
        print(f"\nUploaded {total_uploads_ok}/{total_chunks} chunks; errors {total_uploads_err}.")
    else:
        print(f"\nWrote {total_chunks} chunks to {args.output}")
        print("Next: feed to PulseAgent KB importer with collection=conversation_history.")


if __name__ == "__main__":
    main()
