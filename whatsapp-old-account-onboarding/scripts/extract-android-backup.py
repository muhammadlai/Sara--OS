#!/usr/bin/env python3
"""
Extract WhatsApp conversations from an Android msgstore.db.crypt15 backup.

Inputs:
  --crypt15        Path to msgstore.db.crypt15 (from /sdcard/Android/media/
                   com.whatsapp/WhatsApp/Databases/ — adb pull it first)
  --key            64-char hex key (WhatsApp → Settings → Account →
                   End-to-end encrypted backup → Manage → Reveal key)
                   Strip spaces.
  --wa-db          Optional: path to wa.db (contacts table) for proper names
  --owner-name     Display name to use for "me" in exported .txt files
  --output         Directory to write per-contact .txt files
  --include-groups Include group chats (default: skip)

Outputs:
  <output>/Chat with <ContactName>.txt    in Android-style WhatsApp export format

Dependencies (optional / extraction-only):
  pip install -r scripts/requirements-extract.txt

Tested against WhatsApp Android 2.23.x — 2.24.x; crypt14/crypt15 supported via
wa-crypt-tools. Older crypt12 not supported (rotate to a fresh backup).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

try:
    from wa_crypt_tools.lib.db.dbfactory import Dbfactory  # type: ignore[import]
    from wa_crypt_tools.lib.key.keyfactory import KeyFactory  # type: ignore[import]
except ImportError:
    sys.exit(
        "Missing dependency 'wa-crypt-tools'. Install:\n"
        "    pip install -r scripts/requirements-extract.txt"
    )

SAFE_FILENAME = str.maketrans({c: "_" for c in '<>:"/\\|?*\n\r\t'})


def safe_name(name: str) -> str:
    return name.translate(SAFE_FILENAME).strip()[:80] or "unknown"


def ms_to_dt(ms: int | None) -> datetime | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def detect_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info('{table}')")}


def load_contacts(wa_db_path: Path | None) -> dict[str, str]:
    """jid -> display name."""
    if not wa_db_path or not wa_db_path.is_file():
        return {}
    conn = sqlite3.connect(str(wa_db_path))
    try:
        cols = detect_columns(conn, "wa_contacts")
        name_cols = [c for c in ("display_name", "wa_name", "given_name", "number") if c in cols]
        if not name_cols:
            return {}
        rows = conn.execute(f"SELECT jid, {', '.join(name_cols)} FROM wa_contacts").fetchall()
        return {jid: next((v for v in vals if v), jid) for jid, *vals in rows}
    finally:
        conn.close()


def list_chats(conn: sqlite3.Connection, include_groups: bool) -> list[tuple[int, str]]:
    """Return [(chat_row_id, jid)]. Groups have jid ending in '@g.us'."""
    if "chat" in {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        rows = conn.execute(
            "SELECT chat.chat_row_id, jid.raw_string "
            "FROM chat JOIN jid ON chat.jid_row_id = jid._id"
        ).fetchall()
    else:
        rows = conn.execute("SELECT _id, key_remote_jid FROM chat_list").fetchall()
    out: list[tuple[int, str]] = []
    for row_id, jid in rows:
        if not jid:
            continue
        if not include_groups and jid.endswith("@g.us"):
            continue
        out.append((row_id, jid))
    return out


def chat_turns(conn: sqlite3.Connection, chat_row_id: int, jid: str) -> list[tuple[datetime, bool, str]]:
    """Return [(ts, is_from_me, text)]."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "message" in tables:
        rows = conn.execute(
            "SELECT timestamp, from_me, text_data, message_type "
            "FROM message WHERE chat_row_id = ? ORDER BY timestamp ASC",
            (chat_row_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT timestamp, key_from_me, data, media_wa_type "
            "FROM messages WHERE key_remote_jid = ? ORDER BY timestamp ASC",
            (jid,),
        ).fetchall()
    out: list[tuple[datetime, bool, str]] = []
    for ts_raw, from_me, text, mtype in rows:
        ts = ms_to_dt(ts_raw)
        if not ts:
            continue
        body = text or media_placeholder(mtype)
        if not body:
            continue
        out.append((ts, bool(from_me), body))
    return out


def media_placeholder(media_type: int | None) -> str:
    # WhatsApp Android media_type: 0=text, 1=image, 2=audio, 3=video, 4=contact,
    # 5=location, 9=document, 13=gif, 20=sticker.
    if media_type in (0, None):
        return ""
    return "<Media omitted>"


def write_chat_txt(out_dir: Path, owner_name: str, contact_name: str,
                   turns: list[tuple[datetime, bool, str]]) -> Path:
    path = out_dir / f"Chat with {safe_name(contact_name)}.txt"
    with path.open("w", encoding="utf-8") as fp:
        for ts, from_me, text in turns:
            # Android-export style: "8/12/25, 10:23 AM - Sender: text"
            stamp = ts.strftime("%m/%d/%y, %I:%M %p")
            sender = owner_name if from_me else contact_name
            fp.write(f"{stamp} - {sender}: {text}\n")
    return path


def decrypt_msgstore(crypt15: Path, hex_key: str, out_db: Path) -> None:
    key = KeyFactory.new(hex_key.replace(" ", "").lower())
    db = Dbfactory.from_file(str(crypt15))
    decrypted_bytes = db.decrypt(key)
    out_db.write_bytes(decrypted_bytes)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crypt15", type=Path, required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--wa-db", type=Path)
    ap.add_argument("--owner-name", required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--include-groups", action="store_true")
    args = ap.parse_args()

    if not args.crypt15.is_file():
        sys.exit(f"Not found: {args.crypt15}")

    hex_key = args.key.replace(" ", "").strip()
    if len(hex_key) != 64:
        sys.exit("Key must be 64 hex characters (32 bytes). Strip spaces.")

    args.output.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "msgstore.db"
        print("[info] Decrypting msgstore.db.crypt15…")
        try:
            decrypt_msgstore(args.crypt15, hex_key, db_path)
        except Exception as e:
            sys.exit(f"Decrypt failed: {e}")
        print(f"[info] Decrypted ({db_path.stat().st_size // 1024} KiB)")

        contacts = load_contacts(args.wa_db)
        if contacts:
            print(f"[info] Loaded {len(contacts)} contact names from wa.db")

        conn = sqlite3.connect(str(db_path))
        try:
            chats = list_chats(conn, include_groups=args.include_groups)
            print(f"[info] Found {len(chats)} chats (groups {'included' if args.include_groups else 'skipped'})")

            written = 0
            for chat_row_id, jid in chats:
                contact_name = contacts.get(jid) or jid.split("@")[0]
                turns = chat_turns(conn, chat_row_id, jid)
                if not turns:
                    continue
                write_chat_txt(args.output, args.owner_name, contact_name, turns)
                written += 1
            print(f"[ok]  Wrote {written} chats to {args.output}")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
