"""DepDrift — SQLite Database & Audit History Storage.

Persists completed dependency audits so engineering teams can review
past scans, track dependency drift over time, and export historical audits.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "depdrift.db"


def get_db_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Initialize database tables with indexes."""
    with get_db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS audit_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target TEXT NOT NULL,
                target_type TEXT NOT NULL,
                created_at REAL NOT NULL,
                total_deps INTEGER NOT NULL DEFAULT 0,
                outdated_count INTEGER NOT NULL DEFAULT 0,
                critical_count INTEGER NOT NULL DEFAULT 0,
                breaking_count INTEGER NOT NULL DEFAULT 0,
                safe_count INTEGER NOT NULL DEFAULT 0,
                results_json TEXT NOT NULL,
                stats_json TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_history(target)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_history(created_at DESC)")
        conn.commit()


def save_audit(
    target: str,
    target_type: str,
    results: list[dict[str, Any]],
    stats: dict[str, Any]
) -> int:
    """Save a completed audit to database and return its ID."""
    init_db()
    total_deps = stats.get("total_deps", 0)
    outdated = stats.get("outdated", 0)
    critical = stats.get("critical", 0)
    
    # Calculate breaking and safe counts from results
    breaking = 0
    safe = 0
    for repo in results:
        for dep in repo.get("dependencies", []):
            risk = dep.get("risk")
            if risk == "BREAKING":
                breaking += 1
            elif risk == "SAFE":
                safe += 1

    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO audit_history (
                target, target_type, created_at,
                total_deps, outdated_count, critical_count,
                breaking_count, safe_count, results_json, stats_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                target,
                target_type,
                time.time(),
                total_deps,
                outdated,
                critical,
                breaking,
                safe,
                json.dumps(results),
                json.dumps(stats),
            ),
        )
        conn.commit()
        return cursor.lastrowid or 0


def list_audits(limit: int = 50) -> list[dict[str, Any]]:
    """List recent audits."""
    init_db()
    with get_db_connection() as conn:
        rows = conn.execute(
            """
            SELECT id, target, target_type, created_at,
                   total_deps, outdated_count, critical_count,
                   breaking_count, safe_count
            FROM audit_history
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]


def get_audit(audit_id: int) -> dict[str, Any] | None:
    """Fetch an audit by ID with full results and stats."""
    init_db()
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM audit_history WHERE id = ?", (audit_id,)
        ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["results"] = json.loads(data["results_json"])
        data["stats"] = json.loads(data["stats_json"])
        return data


def delete_audit(audit_id: int) -> bool:
    """Delete an audit from history."""
    init_db()
    with get_db_connection() as conn:
        cursor = conn.execute("DELETE FROM audit_history WHERE id = ?", (audit_id,))
        conn.commit()
        return cursor.rowcount > 0
