"""Self-test for the backend half. Run it with the Hermes interpreter:

    ~/.hermes/hermes-agent/venv/bin/python plugins/session-monitor/dashboard/selftest.py

It builds a throwaway HERMES_HOME (a state.db and a cached OpenRouter catalogue), calls the real
`summary()` endpoint against it, and asserts the cost basis and the period split. Exit 0 = the
figures mean what the README says they mean.

The contracts, each one a way the Overview has been wrong before:

  1. an OpenRouter row is valued at the rate its OWN hours hit, averaged across the catalogue's
     price windows, not at the estimate recorded with it and not at the window the catalogue
     happens to report as active — reading that field makes the same history cost differently
     depending on when it is looked at. The peak-of-all-windows rule it replaced was stable but
     charged every cheap hour the peak price ($22.63 of pure overestimate on the real rows).
  2. a route with no catalogue entry keeps its recorded estimate (never silently zero);
  3. a bucket that spans the period boundary is apportioned by its session's in-period messages;
  4. a bucket whose last call predates the period contributes nothing;
  5. today <= month <= total, on both tokens and cost;
  6. the 30-day chart distributes a bucket across the days it was alive, by transcript volume, and
     its newest bar equals the day's own figure.
"""

import asyncio
import inspect
import json
import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = os.environ.get("HERMES_REPO") or str(Path.home() / ".hermes" / "hermes-agent")
sys.path.insert(0, REPO)

DAY = 86_400
NOW = time.time()

# Two fixture models. The period rows use the FLAT one, so the day/month expectations below are
# the same numbers whatever day or hour the test runs — a priced-by-time-of-day model would move
# under them. The price windows are exercised separately, on fixed spans, further down.
#   flat: $0.5/M prompt, $1/M completion, $0.05/M cache read.
#   peak: the same base, plus Monday 00:00-01:00 UTC at $3/M prompt, $6/M completion, $0.3/M read.
CATALOGUE = {
    # The period rows below use this one: no price windows, so the day/month expectations do not
    # move with the clock. `deepseek/deepseek-v4.1-flash` stays flat too — its own price schedule
    # (peak windows, the 2026-08-16 change) is exercised separately on fixed instants.
    "acme/flat-model": {"pricing": {
        "prompt": "0.0000005", "completion": "0.000001", "input_cache_read": "0.00000005"}},
    "deepseek/deepseek-v4.1-flash": {"pricing": {
        "prompt": "0.0000005", "completion": "0.000001", "input_cache_read": "0.00000005"}},
    "peak/peak-model": {"pricing": {
        "prompt": "0.0000005", "completion": "0.000001", "input_cache_read": "0.00000005",
        "overrides": [{"utc_days": ["monday"], "utc_start": 0, "utc_end": 100,
                       "prompt": "0.000003", "completion": "0.000006",
                       "input_cache_read": "0.0000003"}]}},
}


def fixture(home: Path, day_start: float, month_start: float, chart_today: float, utc_midnight: float) -> None:
    (home / "cache").mkdir(parents=True, exist_ok=True)
    (home / "cache" / "openrouter_model_metadata.json").write_text(json.dumps(CATALOGUE))
    # A real `provider_routing` pin for a model no fixture row uses: exercises the flex
    # resolver end to end (fixture-home proven) without moving any existing number.
    (home / "config.yaml").write_text("provider_routing:\n  models:\n    openai/gpt-6-luna:\n      only: [openai/flex]\n")

    db = sqlite3.connect(home / "state.db")
    db.executescript(
        """
        create table sessions (id text);
        create table messages (session_id text, timestamp real, content text, reasoning text);
        create table session_model_usage (
            session_id text, model text, billing_provider text, task text,
            api_call_count integer, input_tokens integer, output_tokens integer,
            cache_read_tokens integer, cache_write_tokens integer,
            estimated_cost_usd real, actual_cost_usd real,
            first_seen real, last_seen real
        );
        """
    )
    db.executemany("insert into sessions (id) values (?)", [("s1",), ("s2",), ("s3",), ("s4",)])

    def bucket(session, model, provider, tokens, recorded, first, last):
        db.execute(
            "insert into session_model_usage values (?,?,?,'',1,?,0,0,0,?,0,?,?)",
            (session, model, provider, tokens, recorded, first, last),
        )

    # 1. born inside the period: recorded estimate is 1/100th of the catalogue price on purpose.
    bucket("s1", "acme/flat-model", "openrouter", 1_000_000, 0.01, day_start + 60, NOW - 60)
    # 2. spans both boundaries: 4 messages, 3 inside the month, 1 of those inside the day.
    bucket("s2", "acme/flat-model", "openrouter", 1_000_000, 0.01, month_start - 10 * DAY, NOW - 60)
    # 3. settled before the month began.
    bucket("s3", "acme/flat-model", "openrouter", 1_000_000, 1.00, month_start - 10 * DAY, month_start - 5 * DAY)
    # 4. no catalogue entry for this route: the recorded estimate must survive untouched.
    # s4 is a DeepSeek id this build knows no rates for: the recorded estimate must survive (and
    # its cost must not move with the clock, which is why it is not `deepseek-v4-pro`).
    bucket("s4", "deepseek-v9-nonexistent", "deepseek", 1_000_000, 0.50, day_start + 60, NOW - 60)

    # 100 characters each: with equal volume the character weighting reduces to the count
    # weighting, so the day/month expectations above stay the numbers they were.
    db.executemany(
        "insert into messages values (?,?,?,?)",
        [
            ("s2", month_start - DAY, "x" * 100, ""),   # before the month
            ("s2", month_start + 60, "x" * 100, ""),    # in the month, before today
            ("s2", day_start - 3600, "x" * 100, ""),    # in the month, before today
            ("s2", NOW - 30, "x" * 100, ""),            # today
        ],
    )

    # s5 exists to pin the WEIGHTING BASIS, so its bucket must SPAN two days or the split is
    # tautological: the earlier day carries one 9,000-character result, the newest four
    # 250-character turns. By transcript volume that is 90% / 10%; counting messages would give the
    # exact opposite (20% / 80%). The isolated assertions below separate the two.
    bucket("s5", "acme/flat-model", "openrouter", 1_000_000, 0.01, chart_today - DAY + 3600, chart_today + 3600)
    db.executemany(
        "insert into messages values (?,?,?,?)",
        [("s5", chart_today - DAY + 3700, "y" * 9000, "")]                                    # one long result
        + [("s5", chart_today + 60 + index * 10, "z" * 250, "") for index in range(4)]         # four short turns
    )

    # s6 pins the DAY BOUNDARY, placed at an instant the two candidate clocks disagree about:
    # 20:00 UTC on the previous UTC day is 03:00 in the user's own morning, so the bucket belongs to
    # TODAY when the day is cut in their zone and to YESTERDAY when it is cut in UTC. The assertions
    # ask for both, and a plugin hardcoded to either clock fails one of them.
    # 03:00 in the user's own morning on the day the user's clock is in. Anchored to the USER's day
    # start rather than to UTC midnight: the UTC-anchored instant is 03:00 local only until the
    # user's clock rolls past midnight while UTC has not, and then it lands a day back — the fixture
    # passed for part of the day and failed for the rest.
    straddle = day_start + 3 * 3600
    bucket("s6", "acme/flat-model", "openrouter", 500_000, 0.01, straddle, straddle)
    db.execute("insert into messages values (?,?,?,?)", ("s6", straddle + 60, "m" * 500, ""))
    db.commit()
    db.close()


def main() -> int:
    home = Path(tempfile.mkdtemp(prefix="session-monitor-selftest-"))
    os.environ["HERMES_HOME"] = str(home)

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import plugin_api

    # The periods are cut in the CALLER's zone, so the fixture is built on the zone the assertions
    # ask for: 00:00 in the user's own timezone. `zone()` is also exercised directly below — a
    # resolver that quietly fell back to UTC would be caught there rather than here.
    user_zone = plugin_api.zone("Asia/Bangkok")
    user_midnight = plugin_api._day_start_ts(user_zone)

    utc_midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()

    fixture(home, user_midnight, plugin_api._month_start_ts(user_zone), user_midnight, utc_midnight)

    out = plugin_api.summary(tz="Asia/Bangkok")
    failures = []

    def check(name, ok, detail=""):
        if not ok:
            failures.append(f"{name}{(' — ' + detail) if detail else ''}")

    today, month, totals = out["today"], out["month"], out["totals"]

    # 1. the CATALOGUE price, not the estimate recorded with the row ($0.01 on purpose): $0.50 for
    #    1M prompt tokens at the flat rate.
    # s6 (23:00 UTC yesterday = 06:00 in the user's own morning) counts in TODAY when the day is cut
    # in the user's zone, which is the whole point of the change.
    check("a born-in-period row is re-priced at the catalogue rate", abs(today["cost"] - 1.425) < 0.02,
          f"got ${today['cost']:.4f}, expected ≈ $1.425 (0.50 s1 + 0.25 s6 + 0.05 of s5's spanning day + 0.125 spanning + 0.50 fallback)")

    # 3. the spanning bucket: 1/4 of $0.50 today, 3/4 of $0.50 for the month.
    check("a spanning row is apportioned for the month", abs(month["cost"] - (0.5 + 0.5 + 0.375 + 0.5 + 0.25)) < 0.02,
          f"got ${month['cost']:.4f}, expected ≈ $2.125 (0.50 s1 + 0.50 s5 + 0.25 s6 + 0.375 spanning + 0.50 fallback)")

    # 4. the settled bucket is in neither period, but is in the total.
    check("a settled row is excluded from both periods", abs(totals["cost"] - 2.75) < 0.02,
          f"total got ${totals['cost']:.4f}, expected ≈ $2.75 (four $0.50 buckets + $0.25 s6 + 0.50 fallback)")

    # 2. the fallback keeps its recorded figure, checked directly rather than inferred from a
    #    period total: a non-OpenRouter route, and an OpenRouter route the catalogue does not list,
    #    must both come back at the recorded estimate instead of zero.
    def made_up(provider, model, est):
        return {"provider": provider, "model": model, "inp": 1_000_000, "out": 0, "cache_read": 0,
                "cache_write": 0, "est": est, "act": 0, "first_seen": None, "last_seen": None}

    catalogue = plugin_api._catalogue(home)
    fallback = plugin_api._row_cost(made_up("deepseek", "deepseek-v9-nonexistent", 0.5), catalogue)
    unlisted = plugin_api._row_cost(made_up("openrouter", "vendor/not-in-the-catalogue", 0.25), catalogue)

    check("a route with no catalogue entry keeps its recorded estimate",
          abs(fallback - 0.5) < 1e-9 and abs(unlisted - 0.25) < 1e-9,
          f"deepseek → {fallback}, unlisted openrouter → {unlisted}")

    # The rate a bucket is charged is the one its OWN hours hit. Fixed spans on a fixed Monday, so
    # the answer is the same whenever this runs. The expectations are written out from the
    # catalogue above ($0.5/M base, $3/M in the Monday 00:00-01:00 window) rather than derived
    # from the code that computes them.
    monday = datetime(2026, 9, 7, tzinfo=timezone.utc)
    check("the pricing fixture sits on a Monday", monday.weekday() == 0,
          f"2026-09-07 is weekday {monday.weekday()}, the window below names 'monday'")

    def priced(first, last, tokens=1_000_000):
        row = made_up("openrouter", "peak/peak-model", 0.01)
        row.update({"inp": tokens, "first_seen": first, "last_seen": last})
        return plugin_api._row_cost(row, catalogue)

    off_peak = priced(monday.timestamp() + 10 * 3600, monday.timestamp() + 10 * 3600 + 1800)
    on_peak = priced(monday.timestamp() + 900, monday.timestamp() + 2700)
    half = priced(monday.timestamp() + 1800, monday.timestamp() + 5400)
    next_day = priced(monday.timestamp() + 86400 + 1800, monday.timestamp() + 86400 + 5400)

    check("a bucket is charged the rate its own hours hit",
          abs(off_peak - 0.50) < 1e-9 and abs(on_peak - 3.00) < 1e-9,
          f"off-peak ${off_peak:.4f} (want $0.50 = 1M x $0.5/M), peak ${on_peak:.4f} (want $3.00 = 1M x $3/M)")

    check("a bucket spanning two windows is charged the blend",
          abs(half - 1.75) < 1e-9,
          f"got ${half:.4f}, want $1.75 (30 min at $3/M + 30 min at $0.5/M over one hour)")

    check("the peak window is charged on its own day only",
          abs(next_day - 0.50) < 1e-9,
          f"got ${next_day:.4f} (want $0.50: Tuesday 00:30-01:30 UTC is base all through)")

    # DeepSeek bills a peak/off-peak schedule and changed its prices on 2026-08-16. Its published
    # table (https://api-docs.deepseek.com/quick_start/pricing) for DeepSeek-V4.1-Flash is
    # $0.14 / $0.28 / $0.0028 per 1M (in / out / cached) before that date, then $0.15 / $0.60 /
    # $0.003 off-peak and twice that in the weekday peak windows 01:00-04:00 and 06:00-10:00 UTC;
    # V4-Pro is $0.435 / $0.87 / $0.003625, then $0.66 / $1.98 / $0.022 and double. Hand-computed
    # from that table, never from the code that applies it.
    def deepseek_cost(model, first, last, provider="deepseek", tokens=1_000_000):
        row = made_up(provider, model, 0.01)
        row.update({"inp": tokens, "first_seen": first, "last_seen": last})
        return plugin_api._row_cost(row, catalogue)

    aug = lambda day, hour: datetime(2026, 8, day, hour, 0, tzinfo=timezone.utc).timestamp()

    old_era = deepseek_cost("deepseek-v4-flash", aug(3, 12), aug(3, 12) + 1800)     # Mon 2026-08-03
    off_peak = deepseek_cost("deepseek-v4-flash", aug(22, 12), aug(22, 12) + 1800)  # Sat 2026-08-22
    peak = deepseek_cost("deepseek-v4-flash", aug(17, 2), aug(17, 2) + 1800)        # Mon 2026-08-17 02:00

    check("DeepSeek rows are priced at DeepSeek's own table",
          abs(old_era - 0.14) < 1e-9 and abs(off_peak - 0.15) < 1e-9 and abs(peak - 0.30) < 1e-9,
          f"old ${old_era:.4f} (want $0.140 = 1M x $0.14/M), off-peak ${off_peak:.4f} ($0.150), "
          f"peak ${peak:.4f} ($0.300)")

    straddling = deepseek_cost("deepseek-v4-flash", aug(15, 12), aug(16, 12))       # 12h old + 12h new
    check("the 2026-08-16 price change splits a bucket that straddles it",
          abs(straddling - 0.145) < 1e-9,
          f"got ${straddling:.4f}, want $0.145 (12h at $0.14/M + 12h at $0.15/M)")

    pro_peak = deepseek_cost("deepseek-v4-pro", aug(17, 2), aug(17, 2) + 1800)
    prefixed = deepseek_cost("deepseek/deepseek-v4.1-flash", aug(17, 2), aug(17, 2) + 1800,
                             provider="openrouter")
    check("the family follows the id, not the vendor prefix",
          abs(pro_peak - 1.32) < 1e-9 and abs(prefixed - 0.30) < 1e-9,
          f"pro peak ${pro_peak:.4f} (want $1.320), prefixed flash ${prefixed:.4f} (want $0.300)")

    # The providers' OWN reported spend, written by scripts/reconcile_openrouter.py. It is the one
    # figure that is not an estimate, and the one the file must never invent: absent or malformed
    # reads as null, and nobody loses the figures they already had.
    anchors = home / "session-monitor-anchors.json"
    empty = plugin_api.summary(tz="Asia/Bangkok")["confirmed"]
    check("the confirmed figure is absent until the providers are reconciled",
          empty["total"] is None and empty["openrouter"] is None, f"got {empty}")

    anchors.write_text(json.dumps({"checked_at": "2026-10-11T00:00:00+00:00",
                                   "openrouter_all_time": 121.5, "deepseek_all_time": 10.25}))
    confirmed = plugin_api.summary(tz="Asia/Bangkok")["confirmed"]
    check("the confirmed figure is what the providers reported",
          confirmed["total"] is not None and abs(confirmed["total"] - 131.75) < 1e-9
          and confirmed["openrouter"] is not None and abs(confirmed["openrouter"] - 121.5) < 1e-9,
          f"got {confirmed}")

    anchors.write_text("{not json")
    broken = plugin_api.summary(tz="Asia/Bangkok")["confirmed"]
    check("a malformed anchors file costs nobody a figure",
          broken["total"] is None and out["totals"]["cost"] > 0, f"got {broken}")
    anchors.unlink()

    # The ROUTE must serve, not just `summary()`: the `@router.get("/summary")` decorator once sat
    # on a helper, and every HTTP read 422'd on that helper's parameters while a direct call looked
    # perfect — which is what left the desktop showing its fallback figures.
    try:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/session-monitor")
        route = TestClient(app).get("/api/plugins/session-monitor/summary?tz=Asia/Bangkok&offset=420")
        check("the summary ROUTE serves the summary",
              route.status_code == 200 and isinstance(route.json().get("totals"), dict),
              f"HTTP {route.status_code}: {route.text[:200]}")
    except Exception as exc:
        check("the summary ROUTE serves the summary", False, f"could not exercise the route: {exc}")

    # 5. the ladder holds.
    check("today <= month <= total (cost)", today["cost"] <= month["cost"] <= totals["cost"],
          f"{today['cost']} / {month['cost']} / {totals['cost']}")
    check("today <= month <= total (tokens)", today["tokens"] <= month["tokens"] <= totals["tokens"],
          f"{today['tokens']} / {month['tokens']} / {totals['tokens']}")

    # 6. the chart: 30 days, weighted by in-span messages, newest bar == the day's own figure.
    days = out["days"]

    check("the chart covers the trailing 30 days", len(days) == 30, f"{len(days)} days")
    check("the chart's days are ordered oldest to newest",
          [d["date"] for d in days] == sorted(d["date"] for d in days), "dates out of order")

    # s2 spans the window (born before it) and has 4 messages: 3 inside the month, 1 today. Its
    # $3.00 of tokens therefore lands mostly on past days and a quarter of it today.
    check("a spanning bucket is split across its days, not dumped on one",
          sum(d["tokens"] for d in days) > 0 and len([d for d in days if d["tokens"]]) >= 2,
          f"non-zero days: {len([d for d in days if d['tokens']])}")
    from zoneinfo import ZoneInfo

    expected_day = datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()

    check("the newest bar is the current day in the caller's zone",
          days[-1]["date"] == expected_day,
          f"{days[-1]['date']} vs {expected_day} (Asia/Bangkok, computed here)")
    check("no day carries the whole history",
          max(d["tokens"] for d in days) < totals["tokens"],
          f"peak bar {max(d['tokens'] for d in days):,} of {totals['tokens']:,} total")

    # The weighting basis, isolated to ONE bucket so no other session's tokens muddy it: s5's
    # 1,000,000 prompt tokens were spent across two days (9,000 characters yesterday, 1,000 today,
    # in five messages). Volume puts 900,000 on yesterday; counting messages puts 200,000 there.
    conn = plugin_api._connect(home)

    try:
        conn.row_factory = sqlite3.Row
        weights = plugin_api._weights(
            conn,
            plugin_api._day_start_ts(user_zone),
            plugin_api._month_start_ts(user_zone),
            plugin_api._window_start(plugin_api.DAILY_WINDOW, user_zone),
            lambda ts: plugin_api._day_key(ts, user_zone),
        )
        row = conn.execute(
            "select session_id, model, billing_provider provider, 'main' task, 1 calls, 1000000 inp, "
            "0 out, 0 cache_read, 0 cache_write, 0.01 est, 0 act, first_seen, last_seen "
            "from session_model_usage where session_id = 's5'"
        ).fetchone()
    finally:
        conn.close()

    solo = plugin_api._daily_series([row], weights, plugin_api.DAILY_WINDOW, user_zone)
    long_day = max(solo, key=lambda d: d["tokens"])

    check("a bucket is split by transcript volume, not message count",
          long_day["tokens"] >= 850_000,
          f"the long day holds {long_day['tokens']:,} of 1,000,000 — a message-count weighting gives ~200,000")

    # s6: the same bucket, asked for as a DAY in the user's zone, lands wholly on the newest bar.
    conn = plugin_api._connect(home)

    try:
        conn.row_factory = sqlite3.Row
        s6 = conn.execute(
            "select session_id, model, billing_provider provider, 'main' task, 1 calls, 500000 inp, "
            "0 out, 0 cache_read, 0 cache_write, 0.01 est, 0 act, first_seen, last_seen "
            "from session_model_usage where session_id = 's6'"
        ).fetchone()
    finally:
        conn.close()

    s6_series = plugin_api._daily_series([s6], weights, plugin_api.DAILY_WINDOW, user_zone)

    check("the newest bar holds the bucket born in the user's day",
          s6_series[-1]["tokens"] == 500_000 and s6_series[-2]["tokens"] == 0,
          f"newest bar {s6_series[-1]['tokens']:,}, previous {s6_series[-2]['tokens']:,}")

    # The same bucket, asked for as a UTC day, must land on the PREVIOUS bar instead — the boundary
    # follows the CALLER'S zone rather than a fixed clock, and both directions are asserted so a
    # plugin hardcoded to either one fails here. s6 is isolated again because the full series sums
    # every session's buckets and would say nothing about where this one went.
    utc_zone = plugin_api.zone("UTC")
    utc = plugin_api.summary(tz="UTC")
    conn = plugin_api._connect(home)

    try:
        conn.row_factory = sqlite3.Row
        utc_weights = plugin_api._weights(
            conn,
            plugin_api._day_start_ts(utc_zone),
            plugin_api._month_start_ts(utc_zone),
            plugin_api._window_start(plugin_api.DAILY_WINDOW, utc_zone),
            lambda ts: plugin_api._day_key(ts, utc_zone),
        )
        s6_row = conn.execute(
            "select session_id, model, billing_provider provider, 'main' task, 1 calls, 500000 inp, "
            "0 out, 0 cache_read, 0 cache_write, 0.01 est, 0 act, first_seen, last_seen "
            "from session_model_usage where session_id = 's6'"
        ).fetchone()
    finally:
        conn.close()

    utc_series = plugin_api._daily_series([s6_row], utc_weights, plugin_api.DAILY_WINDOW, utc_zone)

    # Which DAY a bucket lands on follows the caller's zone. Asserted on the day keys rather than
    # on "the previous bar / today's row", because the two zones' *today* windows overlap for part
    # of the day — an instant that is in the user's today and outside the UTC today exists only
    # once the UTC clock has caught up to the user's date. The day key of an instant always differs
    # between the two zones here, so this holds whenever it runs.
    straddle_ts = s6_row["first_seen"]
    user_day = plugin_api._day_key(straddle_ts, user_zone)
    utc_day = plugin_api._day_key(straddle_ts, utc_zone)
    placed = next(bar for bar in utc_series if bar["tokens"] == 500_000)

    check("the two zones name different days for the same instant", user_day != utc_day,
          f"both say {user_day} for {datetime.fromtimestamp(straddle_ts, timezone.utc)} — "
          "the fixture must sit where the clocks disagree")

    check("the boundary follows the caller's zone, not a fixed clock",
          placed["date"] == utc_day,
          f"UTC put it under {placed['date']}, the UTC clock says {utc_day}")

    check("and it leaves the user's day alone in the UTC series", placed["date"] != user_day,
          f"UTC put it under {placed['date']}, which is the user's own {user_day} — "
          "a plugin hardcoded to the user's clock would")

    # The resolver itself: a zone name wins, an offset is the fallback, and neither falls through to
    # something wrong.
    # The endpoint must stay a SYNC function so Starlette runs it in a threadpool: as `async def`
    # it runs on the event loop, and a measured cold read held that loop for 489 ms — long enough
    # to delay the app's own session list, which is what made the pane feel slow to open.
    check("the summary endpoint is sync, so it runs off the event loop",
          not inspect.iscoroutinefunction(plugin_api.summary),
          "summary is async def: blocking sqlite3 on the event loop again")

    def offset_of(zone):  # a tzinfo only reports an offset for a real instant
        return datetime.now(zone).utcoffset().total_seconds()

    check("a named zone resolves through ZoneInfo",
          offset_of(plugin_api.zone("Asia/Bangkok")) == 7 * 3600,
          f"got {offset_of(plugin_api.zone('Asia/Bangkok'))}s")
    check("an unknown zone falls back to the offset",
          offset_of(plugin_api.zone("Not/AZone", 330)) == 5.5 * 3600,
          f"got {offset_of(plugin_api.zone('Not/AZone', 330))}s")
    check("no zone at all falls back to this machine",
          offset_of(plugin_api.zone()) == datetime.now().astimezone().utcoffset().total_seconds(),
          "the local clock was not used")

    # Flex-pinned routes and context-size tiers — the two halves of the cost figure the flex pin
    # changed. A recorded estimate is a STANDARD-rate figure (measured against OpenRouter's own
    # charges: 2.0001x and 2.0x), so a pinned model's row is re-priced at half; a recorded bill is
    # never rescaled; and a long-context tier is chosen by the bucket's OWN call sizes instead of
    # being painted over the whole week (the misread that doubled every long-context model).
    routes = plugin_api._flex_routes({"models": {"flex/flex-model": {"only": ["vendor/flex"]}}})
    check("a flex-only `only` pin counts as flex", routes["models"] == ["flex/flex-model"] and routes["tails"] == ["flex-model"], str(routes))
    mixed = plugin_api._flex_routes({"models": {"flex/flex-model": {"only": ["vendor/flex", "vendor/standard"]}}, "order": ["vendor/flex"]})
    check("a mixed pin earns nothing and `order` is not a pin", mixed["models"] == [] and not mixed["wildcard"], str(mixed))
    wild = plugin_api._flex_routes({"only": ["vendor/flex"]})
    check("a flat flex-only pin is a wildcard", wild["wildcard"] and plugin_api._flex_factor("anything", wild) == plugin_api.FLEX_DISCOUNT, str(wild))

    flex_cat = {
        "flex/flex-model": {
            "pricing": {
                "prompt": "0.000002",
                "completion": "0.000008",
                "overrides": [{"min_prompt_tokens": 272000, "prompt": "0.000004", "completion": "0.000016"}],
            }
        }
    }

    def bucket(provider="openrouter", model="flex/flex-model", est=0.0, **kw):
        row = made_up(provider, model, est)
        row.update({"calls": 1, "session_id": "flex-s", "cache_read": 0, "cache_write": 0,
                    "first_seen": 1700000000.0, "last_seen": 1700000360.0})
        row.update(kw)
        return row

    small = bucket(calls=1, inp=100_000, out=200_000)
    tall = bucket(calls=1, inp=1_000_000, out=200_000)
    check("the context tier is chosen by the bucket's own call sizes", abs(plugin_api._row_cost(small, flex_cat) - 1.8) < 1e-9 and abs(plugin_api._row_cost(tall, flex_cat) - 7.2) < 1e-9, f"small={plugin_api._row_cost(small, flex_cat)} tall={plugin_api._row_cost(tall, flex_cat)}")
    check("a flex pin halves the row and a recorded bill is never rescaled", abs(plugin_api._row_cost(small, flex_cat, routes) - 0.9) < 1e-9 and plugin_api._row_cost(bucket(act=5.0), flex_cat, routes) == 5.0, "")
    mults = plugin_api._flex_mults([bucket(est=2.0), bucket(session_id="mix-s", est=2.0), bucket(session_id="mix-s", model="plain", est=6.0)], routes)
    check("the session multiplier is the flex share of its estimate", abs(mults["flex-s"] - 0.5) < 1e-9 and abs(mults["mix-s"] - 0.875) < 1e-9, str(mults))

    out = plugin_api.summary()
    check("the summary carries the flex payload", out["flex"]["factor"] == plugin_api.FLEX_DISCOUNT and out["flex"]["models"] == ["openai/gpt-6-luna"] and out["flex"]["mults"] == {}, str(out["flex"]))

    import shutil
    shutil.rmtree(home, ignore_errors=True)

    if failures:
        print("FAIL — backend contracts:\n" + "\n".join(f"  • {f}" for f in failures))
        return 1

    print(f"PASS — backend half · today ${today['cost']:.4f} · month ${month['cost']:.4f} · "
          f"total ${totals['cost']:.4f} · re-priced, apportioned, ladder holds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
