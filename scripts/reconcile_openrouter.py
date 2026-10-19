#!/usr/bin/env python3
"""Compare the session monitor's numbers with what OpenRouter actually reports.

Run it by hand, whenever you want to check the Overview against the invoice:

    OPENROUTER_API_KEY=... python3 scripts/reconcile_openrouter.py

It reads nothing but your own account's totals from OpenRouter (no model, prompt or
session detail leaves or arrives) and the local state.db the Overview is built on, and
prints the two side by side with the gap named. Nothing is stored, nothing is sent.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if key:
        return key

    for line in (Path.home() / ".hermes" / ".env").read_text(errors="replace").splitlines():
        m = re.match(r'\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.+?)\s*$', line)
        if m:
            return m.group(1).strip().strip('"').strip("'")

    raise SystemExit("no OPENROUTER_API_KEY in the environment or ~/.hermes/.env")


def get(url: str, key: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["data"]


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Compare the session monitor against the providers' own reports.")
    parser.add_argument(
        "--deepseek-amount",
        type=float,
        default=None,
        help="DeepSeek's total spend as their console shows it. Their API exposes only the balance, "
        "never the spend, so this can only be typed in; leave it out and that side stays unknown.",
    )
    args = parser.parse_args()

    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    key = api_key()

    account = get("https://openrouter.ai/api/v1/credits", key)
    mine = get("https://openrouter.ai/api/v1/key", key)

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "plugins" / "session-monitor" / "dashboard"))
    import plugin_api

    summary = plugin_api.summary()
    db = sqlite3.connect(f"file:{home / 'state.db'}?mode=ro", uri=True)

    try:
        estimate = db.execute(
            "select coalesce(sum(coalesce(estimated_cost_usd, 0)), 0) from session_model_usage"
            " where coalesce(billing_provider, '') = 'openrouter'"
        ).fetchone()[0]
    finally:
        db.close()

    or_rows = summary["byProvider"].get("openrouter", {}).get("cost", 0.0)
    other = sum(v["cost"] for name, v in summary["byProvider"].items() if name != "openrouter")
    invoice = float(account["total_usage"])

    print("OpenRouter's own report")
    print(f"   account all-time   ${invoice:9.2f}")
    print(f"   this API key       ${float(mine['usage']):9.2f}   month ${float(mine['usage_monthly']):.2f}"
          f"   day ${float(mine['usage_daily']):.2f}")
    print()
    print("the session monitor")
    print(f"   OpenRouter rows    ${or_rows:9.2f}   (re-priced from recorded tokens x catalogue rates)")
    print(f"   other providers    ${other:9.2f}   (billed directly — OpenRouter never sees this)")
    print(f"   recorded estimate  ${estimate:9.2f}   (what Hermes wrote down at call time)")
    print(f"   total shown        ${summary['totals']['cost']:9.2f}")
    print()

    gap = or_rows - invoice
    print(f"gap on the OpenRouter part: {gap:+.2f}  ({100 * gap / invoice:+.1f}% of the invoice)")
    print(f"the invoice sits between the two local rules: recorded ${estimate:.2f} (low)"
          f" .. re-priced ${or_rows:.2f} (high)")

    if abs(gap) / invoice > 0.05:
        print()
        print("more than 5% apart. Known causes, in order of size:")
        print("   1. the catalogue lists one rate per model — whichever price window is ACTIVE when")
        print("      Hermes refreshed it — and history is priced at that. Check whether the model")
        print("      still publishes `overrides` (its cheap windows) in")
        print("      ~/.hermes/cache/openrouter_model_metadata.json.")
        print("   2. OpenRouter charges things no token x rate reproduces: context tiers above a")
        print("      threshold, per-search fees, batch discounts.")
        print("   3. recorded token counts run a few percent above what OpenRouter bills for.")
    # The Overview's "Confirmed (providers)" row reads this file: these are the providers' OWN
    # totals, the one figure no local token x rate can reproduce (OpenRouter bills context tiers,
    # per-search fees and vision premiums on top of tokens). A refresh that omits --deepseek-amount
    # keeps whatever was typed before: their API can never supply it, and losing a hand-entered
    # figure to a scheduled run would be the worst possible outcome.
    anchors = {}
    path = home / "session-monitor-anchors.json"
    try:
        previous = json.loads(path.read_text()) if path.exists() else {}
        if isinstance(previous, dict):
            anchors.update(previous)
    except (OSError, ValueError):
        pass

    anchors.update({
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "openrouter_all_time": round(float(account["total_usage"]), 4),
    })
    if args.deepseek_amount is not None:
        anchors["deepseek_all_time"] = round(args.deepseek_amount, 4)
    anchors.setdefault("deepseek_all_time", None)

    path.write_text(json.dumps(anchors, indent=2) + "\n")

    print()
    print(f"anchors written to {path}")
    print(f"   openrouter all-time  ${anchors['openrouter_all_time']:.2f}   (their own report)")
    print("   deepseek all-time    " + (
        f"${anchors['deepseek_all_time']:.2f}   " + (
            "(as you typed it)" if args.deepseek_amount is not None else "(kept from the previous run)")
        if anchors["deepseek_all_time"] is not None else
        "unknown — rerun with --deepseek-amount <USD> to add it"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
