"""One-shot backfill of Hermes' historical sessions into memex.db.

Hermes stores its session history in ~/.hermes/state.db (SQLite, WAL,
schema described in agent diagnostic):

    sessions (id, source, user_id, started_at, ended_at, ...)
    messages (id, session_id, role, content, timestamp, ...)

We walk both tables, derive the same conversation_id used by the live
plugin, and INSERT into memex.db. UNIQUE(source, conversation_id, msg_id)
makes this idempotent — re-running is safe.

Usage:
    memex-hermes-backfill                    # default paths
    memex-hermes-backfill --dry-run          # report counts, write nothing
    memex-hermes-backfill --since 2026-04-01 # only sessions after this date
    memex-hermes-backfill --memex-db /custom/path/memex.db

After backfill, `memex search` (CLI) on the same machine returns Hermes
history alongside any other captured sources.

This is the differentiator: none of Mem0 / Supermemory / hermes-memory /
Hindsight ships a backfill primitive. We do because verbatim storage is
naturally re-importable.
"""

from __future__ import annotations

import argparse
import logging
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Dict, Optional, Tuple

from memex_hermes.conv_id import derive_conv_id, derive_msg_id
from memex_hermes.store import MemexStore, resolve_db_path

log = logging.getLogger(__name__)


def _parse_since(s: Optional[str]) -> Optional[float]:
    """YYYY-MM-DD or unix epoch to epoch seconds."""
    if not s:
        return None
    s = s.strip()
    if s.isdigit():
        return float(s)
    try:
        return time.mktime(time.strptime(s, "%Y-%m-%d"))
    except ValueError:
        log.error("Invalid --since value %r; expected YYYY-MM-DD or unix epoch", s)
        return None


def _open_state_db(state_db_path: Path) -> sqlite3.Connection:
    """Open Hermes state.db read-only via URI mode.

    Hermes daemon may be writing actively (WAL). Read-only URI mode lets
    us iterate without blocking writes.
    """
    if not state_db_path.exists():
        raise FileNotFoundError(f"Hermes state.db not found at {state_db_path}")
    uri = f"file:{state_db_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _backfill_session(
    state_conn: sqlite3.Connection,
    store: MemexStore,
    session_row: sqlite3.Row,
    *,
    dry_run: bool = False,
) -> Tuple[int, int]:
    """Process one Hermes session. Returns (inserted, skipped)."""
    session_id = session_row["id"]
    platform = session_row["source"]
    user_id = session_row["user_id"]
    conv_id = derive_conv_id(platform, user_id, session_id)

    msg_rows = state_conn.execute(
        """
        SELECT id, role, content, timestamp
          FROM messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
           AND content IS NOT NULL
           AND content != ''
         ORDER BY timestamp ASC, id ASC
        """,
        (session_id,),
    ).fetchall()

    if not msg_rows:
        return 0, 0

    inserted = 0
    skipped = 0
    first_ts: Optional[int] = None
    last_ts: Optional[int] = None

    for m in msg_rows:
        role = m["role"]
        text = m["content"] or ""
        if not text.strip():
            continue
        ts = int(m["timestamp"] or 0)
        first_ts = ts if first_ts is None else min(first_ts, ts)
        last_ts = ts if last_ts is None else max(last_ts, ts)

        msg_id = derive_msg_id(role, text, conv_id)
        metadata = {
            "raw_type": "hermes-backfill",
            "session_id": session_id,
            "platform": platform,
            "user_id": user_id,
            "hermes_message_id": m["id"],
        }
        if dry_run:
            inserted += 1
            continue
        wrote = store.insert_message(
            conversation_id=conv_id,
            msg_id=msg_id,
            role=role,
            text=text,
            ts=ts,
            channel=platform,
            metadata=metadata,
        )
        if wrote:
            inserted += 1
        else:
            skipped += 1

    if inserted and not dry_run:
        title = session_row["title"] if "title" in session_row.keys() else None
        store.upsert_conversation(
            conversation_id=conv_id,
            title=title or conv_id,
            first_ts=first_ts,
            last_ts=last_ts,
        )
    return inserted, skipped


def run_backfill(
    *,
    hermes_home: Optional[str] = None,
    memex_db: Optional[str] = None,
    since: Optional[str] = None,
    dry_run: bool = False,
    verbose: bool = False,
) -> Dict[str, int]:
    """Top-level backfill routine.

    Returns a dict with counts: {sessions, inserted, skipped, errors}.
    """
    if verbose:
        logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(name)s %(message)s")
    else:
        logging.basicConfig(level=logging.INFO, format="%(message)s")

    hermes_home_path = Path(os.path.expanduser(hermes_home or "~/.hermes"))
    state_db_path = hermes_home_path / "state.db"
    memex_db_path = resolve_db_path(memex_db)
    since_ts = _parse_since(since)

    log.info("memex-hermes backfill:")
    log.info("  Hermes state.db: %s", state_db_path)
    log.info("  Target memex.db: %s", memex_db_path)
    if since_ts:
        log.info("  Since: %s", time.strftime("%Y-%m-%d", time.localtime(since_ts)))
    if dry_run:
        log.info("  Mode: DRY-RUN (no writes)")
    log.info("")

    state_conn = _open_state_db(state_db_path)
    store = MemexStore(str(memex_db_path)) if not dry_run else MemexStore(str(memex_db_path))
    # Note: even in dry-run we open the target store so schema gets
    # initialised — saves the user one extra step before first real run.

    sessions_sql = "SELECT * FROM sessions"
    params: list = []
    if since_ts:
        sessions_sql += " WHERE started_at >= ?"
        params.append(since_ts)
    sessions_sql += " ORDER BY started_at ASC"

    session_rows = state_conn.execute(sessions_sql, params).fetchall()
    log.info("Found %d session(s) to process.\n", len(session_rows))

    totals = {"sessions": 0, "inserted": 0, "skipped": 0, "errors": 0}
    for i, sess in enumerate(session_rows, 1):
        sess_id = sess["id"]
        platform = sess["source"]
        try:
            inserted, skipped = _backfill_session(state_conn, store, sess, dry_run=dry_run)
        except Exception as e:  # noqa: BLE001
            log.error("  [%d/%d] %s (%s): ERROR %s", i, len(session_rows), sess_id[:8], platform, e)
            totals["errors"] += 1
            continue
        totals["sessions"] += 1
        totals["inserted"] += inserted
        totals["skipped"] += skipped
        if inserted or skipped or verbose:
            log.info(
                "  [%d/%d] %s (%s): +%d new, %d dup",
                i, len(session_rows), sess_id[:8], platform, inserted, skipped,
            )

    state_conn.close()
    store.close()

    log.info("")
    log.info("Done.")
    log.info("  sessions processed: %d", totals["sessions"])
    log.info("  rows inserted:      %d", totals["inserted"])
    log.info("  rows deduplicated:  %d (already in memex)", totals["skipped"])
    if totals["errors"]:
        log.info("  errors:             %d", totals["errors"])
    if dry_run:
        log.info("  (DRY-RUN — nothing was actually written)")
    return totals


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="memex-hermes-backfill",
        description="One-shot backfill of Hermes history into memex.db",
    )
    parser.add_argument(
        "--hermes-home",
        default=os.environ.get("HERMES_HOME", "~/.hermes"),
        help="Path to Hermes home dir (default: ~/.hermes)",
    )
    parser.add_argument(
        "--memex-db",
        default=os.environ.get("MEMEX_DB"),
        help="Path to memex.db (default: ~/.memex/data/memex.db)",
    )
    parser.add_argument(
        "--since",
        help="Only backfill sessions after this date (YYYY-MM-DD or unix epoch).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen without writing.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="More logging.",
    )
    args = parser.parse_args(argv)

    try:
        run_backfill(
            hermes_home=args.hermes_home,
            memex_db=args.memex_db,
            since=args.since,
            dry_run=args.dry_run,
            verbose=args.verbose,
        )
        return 0
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        log.exception("Backfill failed")
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
