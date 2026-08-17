#!/usr/bin/env python3
"""
One-shot branding migration for the Sara--OS integration.

Converts owner/project branding references from the source project
(iPythoning, PulseAgent) to the new project identity (muhammadlai/Sara--OS,
AITZAZ AI / aitzaz) while protecting third-party and external identifiers:
  - URLs belonging to external services (pulseagent.io, x.com/PulseAgentHQ)
  - the external b2b-sdr-hermes-skill repository reference
  - package names, API providers, funding identifiers (dayongfan)

The script is written so it is safe to run repeatedly (idempotent) and it
excludes itself from rewriting.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Paths that must never be rewritten (relative to repo root)
SKIP_PATHS = {"scripts/rebrand.py", "social-preview.png"}
# Binary-ish extensions we skip (images)
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".webp"}


def rewrite(text: str) -> str:
    # 1) The old source repository -> new target repository (all URL forms +
    #    bare owner/repo references, e.g. install.sh REPO="...").
    text = text.replace(
        "iPythoning/b2b-sdr-agent-template",
        "muhammadlai/Sara--OS",
    )

    # 2) Remaining iPythoning username references -> aitzaz (protecting the
    #    external b2b-sdr-hermes-skill repo reference, which still lives at
    #    its own location).
    text = re.sub(
        r"iPythoning(?=/b2b-sdr-hermes-skill)",
        "IPYTHONING_HERMES_KEEP",
        text,
    )
    text = text.replace("iPythoning", "aitzaz")
    text = text.replace("IPYTHONING_HERMES_KEEP", "iPythoning")

    # 3) Old project brand name -> AITZAZ AI. The only concatenated form to
    #    protect is x.com/PulseAgentHQ (an external X account handle); every
    #    other occurrence is the old project brand (including JSON-escaped
    #    "\nPulseAgent" sequences inside .sync blog drafts).
    text = re.sub(r"PulseAgent(?!HQ)", "AITZAZ AI", text)
    return text


def main() -> None:
    changed = 0
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if ".git" in rel.parts or rel.as_posix() in SKIP_PATHS:
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in data[:8192]:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        new_text = rewrite(text)
        if new_text != text:
            path.write_text(new_text, encoding="utf-8")
            print(f"  updated: {rel}")
            changed += 1
    print(f"\n{changed} file(s) updated")


if __name__ == "__main__":
    sys.exit(main())
