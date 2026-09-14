"""Session Monitor — historical totals.

The desktop plugin can only read the app's session ROWS, which carry no request count and no
per-model split. Both live in `session_model_usage`, which only the Python side can reach: this
namespace exposes them at `/api/plugins/session-monitor/...` for the pane's Overview tab.

Read-only: state.db is opened in immutable mode and nothing is written.
"""

import sqlite3
from pathlib import Path

from fastapi import APIRouter

from hermes_constants import get_hermes_home

router = APIRouter()

TOKEN_SUM = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens"


def _db() -> sqlite3.Connection:
    """The active profile's state.db, opened read-only so a dashboard call can never write."""

    return sqlite3.connect(f"file:{Path(get_hermes_home()) / 'state.db'}?mode=ro&immutable=1", uri=True)


@router.get("/summary")
async def summary():
    """Totals for every session Hermes has recorded, with the splits the row cannot carry."""

    db = _db()

    try:
        rows = db.execute(
            f"""
            select coalesce(nullif(task, ''), 'main') task,
                   coalesce(nullif(billing_provider, ''), 'unknown') provider,
                   model,
                   sum(api_call_count) calls,
                   sum({TOKEN_SUM}) tokens,
                   sum(case when actual_cost_usd > 0 then actual_cost_usd else estimated_cost_usd end) cost
            from session_model_usage
            group by 1, 2, 3
            """
        ).fetchall()

        sessions = db.execute("select count(*) from sessions").fetchone()[0]
    finally:
        db.close()

    calls = sum(r[3] or 0 for r in rows)
    tokens = sum(r[4] or 0 for r in rows)
    cost = sum(r[5] or 0 for r in rows)

    def group(index):
        out = {}
        for r in rows:
            key = r[index] or "unknown"
            entry = out.setdefault(key, {"calls": 0, "cost": 0.0, "tokens": 0})
            entry["calls"] += r[3] or 0
            entry["tokens"] += r[4] or 0
            entry["cost"] += r[5] or 0
        return dict(sorted(out.items(), key=lambda kv: kv[1]["cost"], reverse=True))

    return {
        "totals": {"calls": calls, "cost": round(cost, 4), "sessions": sessions, "tokens": tokens},
        "byProvider": group(1),
        "byTask": group(0),
        "byModel": group(2)
    }
