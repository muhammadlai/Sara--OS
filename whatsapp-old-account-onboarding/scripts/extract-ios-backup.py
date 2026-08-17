#!/usr/bin/env python3
"""
Extract WhatsApp conversations from an iOS encrypted backup.

Inputs:
  --backup-dir   Path to the iOS backup folder
                 (default macOS: ~/Library/Application Support/MobileSync/Backup/<UDID>)
  --password     Backup password (set when the user enabled "Encrypt local backup")
                 If omitted, prompts interactively (hidden).
  --owner-name   Display name to use for "me" in exported .txt files
                 (must match the name used later by whatsapp-export-parser.py
                 owner-name flag — the parser uses this to detect direction).
  --output       Directory to write per-contact .txt files
  --include-groups   Include group chats (default: skip)

Outputs:
  <output>/Chat with <ContactName>.txt    in iOS-style WhatsApp export format

Dependencies (optional / extraction-only):
  pip install -r scripts/requirements-extract.txt

What this does NOT do:
  - Decrypt iCloud backups (need iCloud auth + Apple's keychain, out of scope)
  - Handle non-encrypted backups (iOS 17+ effectively requires encryption for
    third-party access)
  - Extract media files (we discard images/audio/video; only text + occurrence
    markers are preserved)

Tested against backups from iOS 16-18 with WhatsApp 24.x.
"""
from __future__ import annotations

import argparse
import getpass
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

try:
    from iphone_backup_decrypt import EncryptedBackup, RelativePath  # type: ignore[import]
except ImportError:
    sys.exit(
        "Missing dependency 'iphone_backup_decrypt'. Install:\n"
        "    pip install -r scripts/requirements-extract.txt"
    )

# WhatsApp on iOS stores ChatStorage.sqlite inside:
#   AppDomainGroup-group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
WA_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
WA_CHATSTORAGE = f"{WA_DOMAIN}/ChatStorage.sqlite"

# Core schema differs slightly across iOS versions; we probe columns at runtime.
SAFE_FILENAME = str.maketrans({c: "_" for c in '<>:"/\\|?*\n\r\t'})


def safe_name(name: str) -> str:
    return name.translate(SAFE_FILENAME).strip()[:80] or "unknown"


def apple_ts_to_dt(seconds_since_2001: float | None) -> datetime | None:
    """ZWAMESSAGE.ZMESSAGEDATE is Apple Core Data epoch (2001-01-01 UTC)."""
    if seconds_since_2001 is None:
        return None
    return datetime(2001, 1, 1, tzinfo=timezone.utc).fromtimestamp(
        seconds_since_2001 + 978307200, tz=timezone.utc
    )


def detect_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info('{table}')")}


def list_chats(conn: sqlite3.Connection, include_groups: bool) -> list[tuple[int, str]]:
    """Return [(chat_pk, display_name)]. Groups have ZGROUPINFO populated."""
    cols = detect_columns(conn, "ZWACHATSESSION")
    name_col = "ZPARTNERNAME" if "ZPARTNERNAME" in cols else "ZCONTACTJID"
    group_filter = "" if include_groups else " WHERE ZGROUPINFO IS NULL"
    rows = conn.execute(
        f"SELECT Z_PK, COALESCE({name_col}, ZCONTACTJID) FROM ZWACHATSESSION{group_filter}"
    ).fetchall()
    return [(pk, name or f"chat_{pk}") for pk, name in rows]


def chat_turns(conn: sqlite3.Connection, chat_pk: int) -> list[tuple[datetime, bool, str]]:
    """Return ordered [(ts, is_from_me, text)] for chat_pk."""
    cols = detect_columns(conn, "ZWAMESSAGE")
    text_col = "ZTEXT" if "ZTEXT" in cols else "ZMESSAGETEXT"
    rows = conn.execute(
        f"""
        SELECT ZMESSAGEDATE, ZISFROMME, {text_col}, ZMESSAGETYPE
        FROM ZWAMESSAGE
        WHERE ZCHATSESSION = ?
        ORDER BY ZMESSAGEDATE ASC
        """,
        (chat_pk,),
    ).fetchall()
    out: list[tuple[datetime, bool, str]] = []
    for ts_raw, is_from_me, text, mtype in rows:
        ts = apple_ts_to_dt(ts_raw)
        if not ts:
            continue
        body = text or media_placeholder(mtype)
        if not body:
            continue
        out.append((ts, bool(is_from_me), body))
    return out


def media_placeholder(message_type: int | None) -> str:
    # WhatsApp iOS ZMESSAGETYPE: 1=image, 2=video, 3=voice, 4=contact, 5=location,
    # 7=url-with-preview, 8=document, 11=sticker. Treat all non-text as <media omitted>.
    if message_type in (0, None):
        return ""
    return "<Media omitted>"


def write_chat_txt(out_dir: Path, owner_name: str, contact_name: str,
                   turns: list[tuple[datetime, bool, str]]) -> Path:
    path = out_dir / f"Chat with {safe_name(contact_name)}.txt"
    with path.open("w", encoding="utf-8") as fp:
        for ts, is_from_me, text in turns:
            stamp = ts.strftime("%Y/%m/%d, %H:%M:%S")
            sender = owner_name if is_from_me else contact_name
            fp.write(f"[{stamp}] {sender}: {text}\n")
    return path


def find_default_backup_dir() -> Path | None:
    base = Path.home() / "Library" / "Application Support" / "MobileSync" / "Backup"
    if not base.is_dir():
        return None
    udids = [p for p in base.iterdir() if p.is_dir() and len(p.name) >= 25]
    if not udids:
        return None
    return max(udids, key=lambda p: p.stat().st_mtime)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backup-dir", type=Path)
    ap.add_argument("--password")
    ap.add_argument("--owner-name", required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--include-groups", action="store_true")
    args = ap.parse_args()

    backup_dir = args.backup_dir or find_default_backup_dir()
    if not backup_dir or not backup_dir.is_dir():
        sys.exit("Could not locate iOS backup directory. Pass --backup-dir explicitly.")
    print(f"[info] Using backup: {backup_dir}")

    password = args.password or getpass.getpass("iOS backup password: ")
    if not password:
        sys.exit("Backup password is required (the one set when you enabled encrypted backup).")

    args.output.mkdir(parents=True, exist_ok=True)

    backup = EncryptedBackup(backup_directory=str(backup_dir), passphrase=password)
    print("[info] Unlocking backup…")
    backup.test_decryption()  # raises on wrong password

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "ChatStorage.sqlite"
        try:
            backup.extract_file(relative_path=WA_CHATSTORAGE, output_filename=str(db_path))
        except Exception as e:
            sys.exit(f"Failed to extract ChatStorage.sqlite from backup: {e}")
        print(f"[info] Extracted ChatStorage.sqlite ({db_path.stat().st_size // 1024} KiB)")

        conn = sqlite3.connect(str(db_path))
        try:
            chats = list_chats(conn, include_groups=args.include_groups)
            print(f"[info] Found {len(chats)} chats (groups {'included' if args.include_groups else 'skipped'})")

            written = 0
            for pk, name in chats:
                turns = chat_turns(conn, pk)
                if not turns:
                    continue
                write_chat_txt(args.output, args.owner_name, name, turns)
                written += 1
            print(f"[ok]  Wrote {written} chats to {args.output}")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
