#!/usr/bin/env python3
"""
MemOS Upsert — Layer A push

Reads ./profiles/*.yaml and pushes each (where _auto_onboard: true) to a
PulseAgent / OpenClaw MemOS endpoint.

Config sources (first-match wins):
  1. CLI flags --endpoint / --token / --tenant
  2. ./pa-config.json in current directory
  3. ~/.pa-config.json in home directory
  4. PA_ENDPOINT / PA_TOKEN / PA_TENANT env vars

pa-config.json schema:
    {
        "endpoint": "https://your-pa-host",
        "token":    "Bearer-token-from-PA-settings",
        "tenant":   "your-tenant-slug"
    }

Usage:
    python memos-upsert.py --profiles ./profiles
    python memos-upsert.py --profiles ./profiles --dry-run    # print payloads, no HTTP
    python memos-upsert.py --profiles ./profiles --force      # ignore _auto_onboard gate
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib import error, request

import yaml


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


def upsert(cfg: dict[str, str], customer_hash: str, profile: dict[str, Any]) -> tuple[int, str]:
    url = f"{cfg['endpoint'].rstrip('/')}/api/memos/upsert"
    payload = json.dumps(
        {"tenant": cfg.get("tenant"), "customer_hash": customer_hash, "profile": profile}
    ).encode("utf-8")
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
    ap.add_argument("--profiles", type=Path, required=True)
    ap.add_argument("--endpoint", help="PA host (overrides config file)")
    ap.add_argument("--token", help="PA Bearer token (overrides config file)")
    ap.add_argument("--tenant", help="PA tenant slug (overrides config file)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="Push even if _auto_onboard is false")
    args = ap.parse_args()

    cfg = load_config(args)
    if not args.dry_run:
        missing = [k for k in ("endpoint", "token") if k not in cfg]
        if missing:
            sys.exit(f"Missing config keys: {missing}. See script docstring.")

    stats = {"pushed": 0, "skipped_gate": 0, "errors": 0}
    for yaml_path in sorted(args.profiles.glob("*.yaml")):
        if yaml_path.name.startswith("_"):
            continue
        profile = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
        if not args.force and not profile.get("_auto_onboard"):
            stats["skipped_gate"] += 1
            print(f"[skip-gate] {yaml_path.stem}: {profile.get('_gate_reason')}")
            continue
        customer_hash = profile["customer_hash"]

        if args.dry_run:
            print(f"[dry-run] would POST {customer_hash} ({len(json.dumps(profile))} bytes)")
            continue

        code, body = upsert(cfg, customer_hash, profile)
        if 200 <= code < 300:
            stats["pushed"] += 1
            print(f"[ok]  {customer_hash} -> HTTP {code}")
        else:
            stats["errors"] += 1
            snippet = body[:160].replace("\n", " ")
            print(f"[err] {customer_hash} -> HTTP {code}: {snippet}")

    print(f"\nPushed {stats['pushed']}, gated {stats['skipped_gate']}, errors {stats['errors']}.")


if __name__ == "__main__":
    main()
