"""Session Monitor — historical totals.

The desktop plugin can only read the app's session ROWS, which carry no request count and no
per-model split. Both live in `session_model_usage`, which only the Python side can reach: this
namespace exposes them at `/api/plugins/session-monitor/...` for the pane's Overview tab.

Cost basis: an OpenRouter row is valued at OpenRouter's own catalogue price for that model, from
the local cache Hermes already keeps (`cache/openrouter_model_metadata.json`), instead of the
estimate recorded when the call was made. A recorded estimate is computed with the rates in force
at that moment and is never revised, so it drifts below the catalogue whenever a price rises —
which is why the Overview used to read low against the invoice. Re-pricing the same tokens removes
that drift, and the price charged is the one the row's OWN calls were subject to: time-of-day/week
windows blended across the bucket's `first_seen`→`last_seen` span, the long-context tier chosen by
the row's average prompt per call (see `_rates`), and the flex discount for models the user routes
to OpenRouter's flex endpoints (measured at exactly half the standard rates — see `_row_cost`).
What it still cannot add: per-search fees and other non-token charges, so the figure may trail the
invoice slightly. Routes with no catalogue entry keep their recorded estimate.

Read-only: state.db is opened with ``mode=ro`` (writes are refused by SQLite itself), the cache is
only read, `config.yaml` is read only for its `provider_routing` block (which models are pinned to
flex endpoints), and nothing touches the network.
"""

import contextlib
import json
import sqlite3
from datetime import datetime, time, timedelta, timezone
from time import monotonic as _monotonic
from pathlib import Path

from fastapi import APIRouter

from hermes_constants import get_hermes_home

router = APIRouter()

#: Days shown in the Overview's per-day bar chart, ending with the current day.
DAILY_WINDOW = 30

#: OpenRouter's catalogue as last cached by Hermes, read once per process.
_CATALOGUE = None


def zone(tz: str | None = None, offset: int | None = None):
    """The clock the periods are cut on — THE USER'S, not the server's.

    The caller (the desktop plugin, which runs on the user's own machine and so knows the real
    timezone) passes the IANA name and the current UTC offset. `ZoneInfo` is preferred, so a zone
    that observes daylight saving follows it across the year; the offset covers a runtime without a
    tz database (Windows without `tzdata`); and with neither, the backend's own local clock is the
    last resort — correct whenever the backend is the user's machine, which is the common case.
    """

    if tz:
        try:
            from zoneinfo import ZoneInfo

            return ZoneInfo(tz)
        except Exception:
            pass

    if offset is not None:
        with contextlib.suppress(Exception):
            return timezone(timedelta(minutes=int(offset)))

    return datetime.now().astimezone().tzinfo or timezone.utc


def _day_key(ts: float, tz) -> str:
    return datetime.fromtimestamp(ts, tz).date().isoformat()


def _day_start_ts(tz, now: datetime | None = None) -> float:
    """00:00 in the user's zone today — the instant the Daily figures reset on."""

    return datetime.combine((now or datetime.now(tz)).date(), time.min, tzinfo=tz).timestamp()


def _month_start_ts(tz, now: datetime | None = None) -> float:
    """00:00 in the user's zone on the first of the current month — the Monthly reset."""

    return datetime.combine((now or datetime.now(tz)).date().replace(day=1), time.min, tzinfo=tz).timestamp()



def _connect(profile_home: Path) -> sqlite3.Connection:
    """A read-only handle that sees CURRENT data.

    Plain ``mode=ro``, deliberately NOT ``immutable=1``: immutable promises SQLite the file cannot
    change, so it skips the write-ahead log and returns a checkpoint-stale view — the same database
    reported a newest bucket of 04:23 under one and 14:38 under the other. Every figure here is
    cumulative, so a stale read is a wrong read (a day's activity simply absent until the next
    checkpoint). ``mode=ro`` still refuses every write, so the guarantee is unchanged; the
    immutable handle remains the fallback for the one case it cannot serve — a WAL whose shared
    memory file cannot be opened.
    """

    path = profile_home / "state.db"

    for uri in (f"file:{path}?mode=ro", f"file:{path}?mode=ro&immutable=1"):
        try:
            db = sqlite3.connect(uri, uri=True, timeout=5)
            db.execute("select 1 from sessions limit 1").fetchone()

            return db
        except sqlite3.Error:
            with contextlib.suppress(Exception):
                db.close()

    raise sqlite3.OperationalError(f"cannot open {path} read-only")


def _catalogue(profile_home: Path) -> dict:
    """OpenRouter's model catalogue as Hermes cached it — the same file its own pricing reads."""

    global _CATALOGUE

    if _CATALOGUE is None:
        import json

        try:
            _CATALOGUE = json.loads((profile_home / "cache" / "openrouter_model_metadata.json").read_text())
        except Exception:
            _CATALOGUE = {}

    return _CATALOGUE


_WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

#: OpenRouter's flex tier is measured at exactly half the standard rates on every token bucket:
#: generation gen-1790108427 on `openai/gpt-6-luna` billed $0.000917587 against a $0.001835175
#: standard-rate recorded estimate (ratio 2.0001, the invoice's own rounding), the same 2.0x ratio
#: on `openai/gpt-5.6-sol` ($0.0183805 billed), and the endpoints catalogue quotes all 22 flex
#: models at exactly 0.5x their standard endpoint.
FLEX_DISCOUNT = 0.5

def _provider_routing() -> dict:
    """The user's `provider_routing` block — the same read the request path makes.

    This is how a row's billing tier is knowable offline at all: `session_model_usage` records no
    service tier, and the pin (`only: [openai/flex]`) is the only evidence a call was billed on
    flex. Read per call (the file is small) and guarded: an unreadable config prices nothing at
    the discount, which is the conservative direction.
    """
    with contextlib.suppress(Exception):
        from hermes_cli.config import load_config_readonly
        routing = load_config_readonly().get("provider_routing")
        return routing if isinstance(routing, dict) else {}

    return {}

def _flex_routes(routing: dict | None = None) -> dict:
    """Models whose routing GUARANTEES the flex discount, as `{models, tails, wildcard}`.

    Only `only` pins count: `only` is a hard whitelist, so a call served through it cannot have
    been billed any other way, while `order` is a preference that can fall back to a standard
    endpoint and therefore earns nothing here. A flat (not per-model) `only` of flex slugs pins
    every route and comes back as `wildcard`. `tails` holds the bare last segments because usage
    rows record ids both with and without their vendor prefix.
    """
    if routing is None:
        routing = _provider_routing()

    def flex_only(only) -> bool:
        return bool(only) and all(str(entry) == "flex" or str(entry).endswith("/flex") for entry in only)

    if not isinstance(routing, dict):
        return {"models": [], "tails": [], "wildcard": False}

    raw_models = routing.get("models")
    models = raw_models if isinstance(raw_models, dict) else {}
    pinned = []

    for model, entry in models.items():
        only = entry.get("only") if isinstance(entry, dict) else None
        # Unset per-model keys fall through to the flat block, as on the request path.
        if flex_only(only if only is not None else routing.get("only")):
            pinned.append(str(model))

    pinned.sort()
    return {
        "models": pinned,
        "tails": sorted({model.rsplit("/", 1)[-1] for model in pinned}),
        "wildcard": flex_only(routing.get("only")),
    }

def _flex_factor(model: str | None, routes: dict | None) -> float:
    """1.0, or FLEX_DISCOUNT when this model's route pins it to flex. Exact id, then bare tail."""
    if not routes:
        return 1.0

    if routes.get("wildcard"):
        return FLEX_DISCOUNT

    name = str(model or "")

    if name in set(routes.get("models") or ()) or name.rsplit("/", 1)[-1] in set(routes.get("tails") or ()):
        return FLEX_DISCOUNT

    return 1.0


def _rates(
    model: str,
    catalogue: dict,
    first_seen: float | None = None,
    last_seen: float | None = None,
    prompt_per_call: float | None = None,
    completion_per_call: float | None = None,
) -> tuple | None:
    """`(prompt, completion, cache_read, cache_write)` per million USD, or None if unlisted.

    OpenRouter's `overrides` come in two kinds and a model carries one or the other (measured
    across the whole catalogue): SIZE TIERS — keyed by `min_prompt_tokens` (the long-context
    premium) or a completion-token band — and TIME-OF-WEEK windows, keyed by `utc_*`. Reading a
    size tier as a time window painted its premium rate over all 168 hours of the week and
    doubled every long-context model's cost (measured: 16 of the 22 flex models on this install
    — the second half of the plugin's 4x overstatement). The bucket's own average call sizes pick
    the tier here; only genuine time windows reach the schedule below. A tier's threshold carries
    OpenRouter's own meaning: `min_prompt_tokens` thresholds the prompt side per call (input +
    cache + write), a completion band thresholds generated tokens per call. With no call count
    to size by, every tier is treated as crossed — the peak bound again, the conservative
    direction.

    The rate the bucket's OWN hours hit, blended across the catalogue's price windows. OpenRouter
    prices some models by time of day and day of week (its `overrides`) and reports whichever window
    is active *now* in `prompt`/`completion` — the same model reads $0.30/M at 09:00 UTC and
    $0.15/M at 14:00 UTC. Reading that field makes history swing with the clock: one bucket, two
    answers depending on when the Overview is looked at.

    This used to take the HIGHEST window instead. Stable, but it priced every cheap hour at the
    peak rate — measured at $22.63 of pure overestimate across the real rows behind the Overview.
    The span a bucket covers (`first_seen` -> `last_seen`) is fixed the moment its calls are
    recorded, so averaging the windows across it is stable AND unbiased. With no span to go on, the
    peak rate is kept as the conservative bound: the Overview is an estimate, and it should not
    read below the invoice.

    An id recorded without its vendor prefix (`deepseek-v4.1-flash`) is matched to the catalogue
    entry whose last path segment is that id, which is how those rows get priced at all.
    """
    entry = catalogue.get(model)

    if entry is None:
        tail = [candidate for candidate in catalogue if candidate.rsplit("/", 1)[-1] == model]
        entry = catalogue[tail[0]] if len(tail) == 1 else None

    if entry is None:
        return None

    def per_million(window: dict, key: str, *aliases: str):
        raw = window.get(key)

        for alias in aliases:
            raw = raw or window.get(alias)

        if raw in (None, ""):
            return None

        try:
            return float(raw) * 1_000_000
        except (TypeError, ValueError):
            return None

    pricing = entry.get("pricing") or {}
    keys = (
        ("prompt",),
        ("completion",),
        ("cache_read", "cached_prompt", "input_cache_read"),
        ("cache_write", "cache_creation", "input_cache_write"),
    )
    base = tuple(per_million(pricing, *key) for key in keys)

    if not base[0] and not base[1]:
        return None

    # The two override kinds are separated here: only a size tier may answer for the bucket's
    # call sizes, and only a `utc_*` window may paint the weekly schedule.
    tiers: list = []
    windows: list = []

    for window in pricing.get("overrides") or []:
        if not isinstance(window, dict):
            continue

        if "min_prompt_tokens" in window:
            tiers.append(("prompt", float(window.get("min_prompt_tokens") or 0), float("inf"), window))
        elif "min_completion_tokens" in window or "max_completion_tokens" in window:
            tiers.append(
                (
                    "completion",
                    float(window.get("min_completion_tokens") or 0),
                    float(window.get("max_completion_tokens") or float("inf")),
                    window,
                )
            )
        else:
            windows.append(window)

    def tier_rate():
        # The HIGHEST tier the bucket's own average calls cross (later tiers win where both
        # match), falling back to base below every threshold.
        best = base

        for kind, low, high, window in tiers:
            per_call = prompt_per_call if kind == "prompt" else completion_per_call

            if per_call is not None and not (low <= per_call <= high):
                continue

            best = tuple((per_million(window, *key) or best[index]) for index, key in enumerate(keys))

        return best

    chosen = tier_rate()

    # One rate per hour of the week: the chosen size tier everywhere, then each window paints the
    # hours it names, and later windows win where two claim the same hour.
    schedule = [chosen] * 168

    for window in windows:
        rate = tuple((per_million(window, *key) or chosen[index]) for index, key in enumerate(keys))
        days = set(window.get("utc_days") or _WEEKDAYS)
        start = int(window.get("utc_start") or 0) // 100
        end = int(window.get("utc_end") or 0) // 100 or 24

        for day in range(7):
            if _WEEKDAYS[day] not in days:
                continue

            for hour in range(start, end):
                schedule[day * 24 + hour] = rate

    def peak():
        return tuple(
            max((slot[i] for slot in schedule if slot[i] is not None), default=None) or base[i]
            for i in range(4)
        )

    if not first_seen or not last_seen or last_seen <= first_seen:
        return peak()

    # Weighted by how long each rate was in force. The windows are whole hours, so walking the span
    # an hour at a time lands exactly on their boundaries.
    acc = [0.0, 0.0, 0.0, 0.0]
    covered = 0.0
    cursor = float(first_seen)

    while cursor < last_seen:
        stamp = datetime.fromtimestamp(cursor, timezone.utc)
        rate = schedule[stamp.weekday() * 24 + stamp.hour]
        step = min(float(last_seen), cursor + 3600 - stamp.minute * 60 - stamp.second) - cursor

        for i in range(4):
            acc[i] += (rate[i] if rate[i] is not None else base[i] or 0) * step

        covered += step
        cursor += step

    return tuple(value / covered for value in acc)


#: Providers billed to a separate Claude plan rather than this cost ledger. Their TOKENS still count
#: everywhere; their COST is kept out of every figure (see `_row_cost` and `summary`).
CLAUDE_PROVIDERS = frozenset({"claude-subscription-directsdk-experimental", "anthropic"})


def _is_claude(provider) -> bool:
    return (provider or "") in CLAUDE_PROVIDERS


_DEEPSEEK_EPOCH = datetime(2026, 8, 16, tzinfo=timezone.utc).timestamp()

#: DeepSeek's own published price schedule, per 1M USD
#: (https://api-docs.deepseek.com/quick_start/pricing, read 2026-10-08): `(prompt, completion,
#: cache_read)`. Two eras — the 2026-08-16 change doubled output and cache prices — and the
#: current table bills PEAK hours at twice the off-peak rate, peak being Mon–Fri 01:00–04:00 and
#: 06:00–10:00 UTC. Chinese public holidays are excluded from DeepSeek's peak definition and are
#: unknowable locally, so a holiday is priced as an ordinary weekday.
#:
#: OpenRouter bills the same ids at the same schedule: its catalogue published exactly these
#: windows for `deepseek/deepseek-v4.1-flash` until its 2026-10-08 refresh dropped them and left a
#: single flat rate — whichever window was ACTIVE at fetch time, which is the peak one for anyone
#: working in Asia. This table is what fills that gap: the catalogue stays authoritative whenever
#: it still lists its own `overrides`, and this is consulted only when it does not.
_DEEPSEEK_RATES = {
    "flash": {
        "until": (0.14, 0.28, 0.0028),
        "from": (0.15, 0.60, 0.003),
        "peak": (0.30, 1.20, 0.006),
    },
    "pro": {
        "until": (0.435, 0.87, 0.003625),
        "from": (0.66, 1.98, 0.022),
        "peak": (1.32, 3.96, 0.044),
    },
}

#: Which family a DeepSeek id bills as. The legacy names `deepseek-v4-flash` and
#: `deepseek-v4-flash-vision-exp` are retired ids still accepted by the API and served — and billed
#: — as DeepSeek-V4.1-Flash (`deepseek-flash`), so they share its entry. `deepseek-v4-flash-0731` is
#: a dated snapshot with a price of its own and is deliberately absent: its catalogue rate applies.
_DEEPSEEK_FAMILY = {
    "deepseek-flash": "flash",
    "deepseek-chat": "flash",
    "deepseek-v4-flash": "flash",
    "deepseek-v4-flash-vision-exp": "flash",
    "deepseek-v4.1-flash": "flash",
    "deepseek-v4-pro": "pro",
    "deepseek-v4.1-pro": "pro",
    "deepseek-reasoner": "pro",
}


def _deepseek_entry(model: str, era_start: float) -> dict:
    """An OpenRouter-shaped entry, so `_rates` blends DeepSeek's peak windows exactly as it does
    OpenRouter's — one window walker, not two."""
    rates = _DEEPSEEK_RATES[_deepseek_family(model)]
    base = rates["from"] if era_start >= _DEEPSEEK_EPOCH else rates["until"]
    peak = rates["peak"]

    def per_token(value):
        return repr(value / 1_000_000)

    pricing = {"prompt": per_token(base[0]), "completion": per_token(base[1]), "input_cache_read": per_token(base[2])}

    if era_start >= _DEEPSEEK_EPOCH:
        pricing["overrides"] = [
            {
                "utc_days": ["monday", "tuesday", "wednesday", "thursday", "friday"],
                "utc_start": start,
                "utc_end": end,
                "prompt": per_token(peak[0]),
                "completion": per_token(peak[1]),
                "input_cache_read": per_token(peak[2]),
            }
            for start, end in ((100, 400), (600, 1000))
        ]

    return {model: {"pricing": pricing}}


def _deepseek_cost(row, model: str, fallback: float) -> float:
    """The row's tokens at DeepSeek's published rates.

    A bucket that straddles the 2026-08-16 price change is split at it, each half priced at its own
    era's rate and weighted by the span — the same shape of approximation the window blend already
    makes, since `session_model_usage` records no per-call ledger to say which tokens fell where.
    """
    first, last = row["first_seen"], row["last_seen"]

    if _deepseek_family(model) is None:
        return fallback

    if not first or not last or last <= first:
        stamp = first or last

        if not stamp:
            return fallback

        rates = _rates(model, _deepseek_entry(model, stamp), stamp, stamp)
        prompt, completion, read, _ = rates
        base = prompt if prompt is not None else completion

        return sum(
            (row[key] or 0) * (rate if rate is not None else base or 0) / 1_000_000
            for key, rate in (("inp", prompt), ("out", completion), ("cache_read", read), ("cache_write", base))
        )

    pieces = [(first, last)]
    if first < _DEEPSEEK_EPOCH < last:
        pieces = [(first, _DEEPSEEK_EPOCH), (_DEEPSEEK_EPOCH, last)]

    span = last - first
    total = 0.0

    for start, end in pieces:
        rates = _rates(model, _deepseek_entry(model, start), start, end)
        prompt, completion, read, _ = rates
        base = prompt if prompt is not None else completion
        piece = (
            (row["inp"] or 0) * (prompt or 0)
            + (row["out"] or 0) * (completion or 0)
            + (row["cache_read"] or 0) * (read if read is not None else base or 0)
            + (row["cache_write"] or 0) * (base or 0)
        ) / 1_000_000
        total += piece * (end - start) / span

    return total


def _known_schedule(model: str, catalogue: dict) -> bool:
    """True when this id's price varies by time and the catalogue no longer says how."""
    if _deepseek_family(model) is None:
        return False

    entry = catalogue.get(model) or {}
    return not ((entry.get("pricing") or {}).get("overrides"))


def _deepseek_family(model: str):
    """The price family a DeepSeek id bills as, or None.

    The vendor prefix is stripped first: `session_model_usage` records the same model both bare
    (`deepseek-v4.1-flash`, billed direct) and prefixed (`deepseek/deepseek-v4.1-flash`, billed by
    OpenRouter), and they share one price schedule. Getting this wrong priced the prefixed rows —
    2.9B tokens, the single largest line — at the flat catalogue rate and left the total unmoved.
    """
    return _DEEPSEEK_FAMILY.get((model or "").rsplit("/", 1)[-1])


def _claude_cost(row, routes=None) -> float:
    """What a Claude-plan row would have cost: the amount kept out of every cost figure."""
    act = float(row["act"] or 0)

    return act if act else float(row["est"] or 0) * _flex_factor(row["model"], routes)


def _row_cost(row: sqlite3.Row, catalogue: dict, routes: dict | None = None) -> float:
    """The row's tokens at the catalogue price, falling back to the recorded estimate.

    An unpriced bucket inside a priced route is charged at the route's prompt rate: leaving it at
    zero would drop real spend, which is the error this exists to correct.

    A recorded ACTUAL charge is returned as recorded and never scaled — a bill is the bill. A
    recorded ESTIMATE is scaled like the re-price below: it is a standard-rate figure even for
    flex-pinned routes (measured against OpenRouter's own charges: 2.0001x on `openai/gpt-6-luna`
    and 2.0x on `openai/gpt-5.6-sol`), so the flex multiplier belongs on it too.

    The multiplier follows the CURRENT pin: `session_model_usage` records no service tier and the
    config keeps no pin history, so usage from before a model was pinned also reads at flex rates.
    Measured on this install that mislabels $1.62 of August `openai/gpt-5.6-luna-pro` usage — and
    only the all-time totals can see it: every daily and monthly figure is inside the pin era. The
    alternative — no discount older than the config's mtime — priced the genuinely-flex September
    `openai/gpt-5.6-sol` rows at standard instead: the same size of error in the other direction.
    """
    if _is_claude(row["provider"]):
        return 0.0

    act = float(row["act"] or 0)

    if act:
        return act

    factor = _flex_factor(row["model"], routes)
    recorded = float(row["est"] or 0) * factor

    # DeepSeek bills a peak/off-peak schedule and changed its prices mid-history, and OpenRouter's
    # catalogue stopped publishing those windows — so neither a flat catalogue rate nor a recorded
    # estimate is the real charge. Price these at DeepSeek's own table (below).
    if (row["provider"] or "") == "deepseek" or _known_schedule(row["model"], catalogue):
        return factor * _deepseek_cost(row, row["model"], recorded)

    if (row["provider"] or "") != "openrouter":
        return recorded

    # A row without a call count (older schemas, hand-made test rows) sizes no tier — see the
    # conservative default in `_rates`.
    calls = 0

    with contextlib.suppress(IndexError, KeyError):
        calls = row["calls"] or 0

    rates = _rates(
        row["model"],
        catalogue,
        row["first_seen"],
        row["last_seen"],
        prompt_per_call=sum((row[key] or 0) for key in ("inp", "cache_read", "cache_write")) / calls if calls else None,
        completion_per_call=(row["out"] or 0) / calls if calls else None,
    )

    if not rates:
        return recorded

    prompt, completion, read, write = rates

    if prompt is None and completion is None:
        return recorded

    base = prompt if prompt is not None else completion

    def part(tokens, rate, fallback):
        return (tokens or 0) * (rate if rate is not None else (fallback or 0)) / 1_000_000

    return factor * (
        part(row["inp"], prompt, base)
        + part(row["out"], completion, base)
        + part(row["cache_read"], read, base)
        + part(row["cache_write"], write, base)
    )


def _sum(rows, cost) -> dict:
    return {
        "calls": sum(r["calls"] or 0 for r in rows),
        "cost": round(sum(cost(r) for r in rows), 4),
        "sessions": len({r["session_id"] for r in rows}),
        "tokens": sum((r["inp"] or 0) + (r["out"] or 0) + (r["cache_read"] or 0) + (r["cache_write"] or 0) for r in rows),
    }


def _window_start(days: int, tz, now: datetime | None = None) -> float:
    """00:00 in the user's zone, `days - 1` days ago — the first instant of the trailing window."""

    today = (now or datetime.now(tz)).date()

    return datetime.combine(today - timedelta(days=days - 1), time.min, tzinfo=tz).timestamp()


#: Characters counted per message: the transcript the model actually read plus what it wrote.
_CHARS = "length(coalesce(content, '')) + length(coalesce(reasoning, ''))"

#: Seconds a computed set of message weights is reused. They only decide how a bucket's cumulative
#: tokens are SPREAD across the days it was alive, so being seconds stale cannot change a figure
#: anyone reads — while recomputing them on every poll cost ~850 ms per request (measured: each
#: length() over `messages` is ~200 ms and the endpoint needed four passes).
WEIGHTS_TTL = 20.0
#: Keyed by the boundary triple, so two callers in different zones (or a zone change) reach their
#: own entry instead of thrashing one slot. Capped: these are small dicts, but they are not free.
_WEIGHTS: dict = {}
_WEIGHTS_MAX = 8


def _weights(db: sqlite3.Connection, day_start: float, month_start: float, window_start: float, day_key) -> dict:
    """Every message-derived weight the figures need, computed in two passes and cached briefly.

    One pass over the window gives the per-day characters a bucket's tokens are spread by; one
    aggregate pass gives each session's lifetime characters and its share inside the current day and
    month. `token_count` is unpopulated on every row, so characters are the timeline — and the only
    cheap invalidation available is time (the values are weights, not measurements).
    """

    key = (day_start, month_start, window_start)
    hit = _WEIGHTS.get(key)

    if hit and (_monotonic() - hit[0]) < WEIGHTS_TTL:
        return hit[1]

    per_day: dict = {}

    for sid, ts, chars in db.execute(
        f"select session_id, timestamp, {_CHARS} from messages where timestamp >= ?", (window_start,)
    ):
        if ts is None:
            continue
        days = per_day.setdefault(sid, {})
        day = day_key(ts)
        days[day] = days.get(day, 0) + (chars or 0)

    lifetime: dict = {}
    day_share: dict = {}
    month_share: dict = {}

    # `chars` is computed once per row in the subquery: repeating the length() expression in three
    # aggregates made SQLite evaluate it three times over every message.
    for sid, total, in_day, in_month in db.execute(
        f"""
        select session_id, sum(chars),
               sum(case when ts >= ? then chars else 0 end),
               sum(case when ts >= ? then chars else 0 end)
        from (select session_id, timestamp ts, {_CHARS} chars from messages)
        group by session_id
        """,
        (day_start, month_start),
    ):
        lifetime[sid] = total or 0

        if total:
            day_share[sid] = (in_day or 0) / total
            month_share[sid] = (in_month or 0) / total

    value = {"per_day": per_day, "lifetime": lifetime, "day": day_share, "month": month_share}

    for stale in [k for k, (at, _) in _WEIGHTS.items() if (_monotonic() - at) > WEIGHTS_TTL * 2]:
        _WEIGHTS.pop(stale, None)

    while len(_WEIGHTS) >= _WEIGHTS_MAX:
        _WEIGHTS.pop(next(iter(_WEIGHTS)), None)

    _WEIGHTS[key] = (_monotonic(), value)

    return value


def _daily_series(rows, weights, days: int, tz, now: datetime | None = None) -> list:
    """Tokens per day over the trailing window — the Overview's bar chart, in the caller's zone.

    `weights` is the cached payload from `_weights`: the character timeline a bucket's tokens are
    spread by, and each session's lifetime total for the in-window share.

    A bucket that began inside the window is spread across the days it was alive, weighted by how
    much text its session moved on each of those days; a bucket that began before the window is
    first scaled by its session's in-window share (the same rule the daily figure uses) so an old
    still-running session cannot dump its whole history onto one bar. A bucket with no activity to
    weight by lands on the day it was last written.
    """

    today = (now or datetime.now(tz)).date()
    keys = [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
    index = {key: position for position, key in enumerate(keys)}
    window_start = _window_start(days, tz, now)
    series = [0] * days
    lifetime, per_day = weights["lifetime"], weights["per_day"]

    for row in rows:
        tokens = (row["inp"] or 0) + (row["out"] or 0) + (row["cache_read"] or 0) + (row["cache_write"] or 0)

        if not tokens or (row["last_seen"] or 0) < window_start:
            continue

        # Weight only by the days THIS bucket was alive: a bucket born today burned today, and
        # spreading it over its session's earlier days would empty today's bar and fatten the past.
        first_day = _day_key(max(row["first_seen"] or window_start, window_start), tz)
        last_day = _day_key(row["last_seen"] or window_start, tz)
        days_with_activity = {
            key: n for key, n in (per_day.get(row["session_id"]) or {}).items()
            if key in index and first_day <= key <= last_day
        }
        scale = 1.0

        if (row["first_seen"] or 0) < window_start:
            total_messages = lifetime.get(row["session_id"]) or 0
            inside = sum(days_with_activity.values())
            scale = min(1.0, inside / total_messages) if total_messages else 0.0

        weight_total = sum(days_with_activity.values())

        if not days_with_activity or not weight_total:
            land = last_day if last_day in index else first_day
            series[index[land]] += int(tokens * (scale if scale else 1.0))
            continue

        for key, weight in days_with_activity.items():
            series[index[key]] += int(tokens * scale * weight / weight_total)

    return [{"date": key, "tokens": value} for key, value in zip(keys, series)]


def _group(rows, catalogue, key, routes=None):
    out = {}

    for row in rows:
        name = row[key] or "unknown"
        entry = out.setdefault(name, {"calls": 0, "cost": 0.0, "tokens": 0})
        entry["calls"] += row["calls"] or 0
        entry["cost"] += _row_cost(row, catalogue, routes)
        entry["tokens"] += (row["inp"] or 0) + (row["out"] or 0) + (row["cache_read"] or 0) + (row["cache_write"] or 0)

    for entry in out.values():
        entry["cost"] = round(entry["cost"], 4)

    return dict(sorted(out.items(), key=lambda kv: kv[1]["cost"], reverse=True))


def _flex_mults(rows, routes: dict) -> dict:
    """Per-session multipliers for the recorded-estimate figures the renderer holds.

    The pane's chip scales a session row's recorded estimate by this: `estimate x mult` is the
    flex-correct cost at whatever the live estimate has grown to. The share is estimated-cost
    weighted over the session's usage buckets — a session can mix pinned and unpinned models
    (measured: 12 on this install) and gets a blended multiplier, while a pure flex session gets
    exactly `FLEX_DISCOUNT` (the acceptance figure: `openai/gpt-6-luna`'s $0.001835175 estimate
    must display $0.0009175875). Sessions at 1.0 are omitted.
    """
    totals: dict = {}
    discounted: dict = {}

    for row in rows:
        est = float(row["est"] or 0)

        if est <= 0:
            continue

        sid = row["session_id"]
        totals[sid] = totals.get(sid, 0.0) + est
        discounted[sid] = discounted.get(sid, 0.0) + est * _flex_factor(row["model"], routes)

    out = {}

    for sid, total in totals.items():
        mult = round(discounted[sid] / total, 6)

        if mult < 0.999999:
            out[sid] = mult

    return out


def _exact_call_tokens(profile_home, start, covered_by_calls):
    """Tokens of every per-call row finished at or after ``start`` (epoch seconds).

    ``session_call_usage`` holds each API call's own tokens and finish time, so this is exact for the
    period. A bucket's lifetime totals (session_model_usage) already include these calls; the caller
    subtracts ``covered_by_calls`` (per-bucket sums from the same table) so nothing is counted twice.
    Returns 0 when the table or its rows don't exist yet.
    """
    db = _connect(profile_home)
    try:
        row = db.execute(
            "select coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) "
            "from session_call_usage where call_time >= ?",
            (start,),
        ).fetchone()
        return int(row[0] or 0)
    except sqlite3.Error:
        return 0
    finally:
        db.close()


def _covered_by_call_rows(profile_home):
    """Per-bucket sums of the per-call rows, keyed the same way as session_model_usage's buckets:
    (session_id, model, billing_provider, task). Used to subtract what call rows already cover."""
    db = _connect(profile_home)
    try:
        out = {}
        for sid, model, prov, task, inp, outp, cr, cw in db.execute(
            "select session_id, model, billing_provider, task, "
            "coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0), "
            "coalesce(sum(cache_read_tokens),0), coalesce(sum(cache_write_tokens),0) "
            "from session_call_usage group by session_id, model, billing_provider, task"
        ):
            # Same key as _bucket_key: the monitor shows an empty task as "main".
            out[(sid, model, prov or "", "" if (task or "") == "main" else (task or ""))] = int(inp + outp + cr + cw)
        return out
    except sqlite3.Error:
        return {}
    finally:
        db.close()


def _bucket_key(row):
    """The key session_model_usage and session_call_usage share: (session, model, provider, task)."""
    return (row["session_id"], row["model"], row["provider"] or "", row["task"] if row["task"] != "main" else "")


def _confirmed(profile_home: Path) -> dict:
    """The providers' own reported spend, written by scripts/reconcile_openrouter.py.

    Read defensively: hand-run tooling writes this file, so it may be absent, partial or malformed —
    none of which may cost anyone a figure. Unknown reads as null, never as a guess.
    """
    empty = {"openrouter": None, "deepseek": None, "checked_at": None, "total": None}

    try:
        raw = json.loads((profile_home / "session-monitor-anchors.json").read_text())
    except (OSError, ValueError):
        return empty

    if not isinstance(raw, dict):
        return empty

    out = dict(empty)

    for key in ("openrouter", "deepseek"):
        value = raw.get(f"{key}_all_time")

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = round(float(value), 4)

    if isinstance(raw.get("checked_at"), str):
        out["checked_at"] = raw["checked_at"]

    if out["openrouter"] is not None or out["deepseek"] is not None:
        out["total"] = round(sum(value for value in (out["openrouter"], out["deepseek"]) if value is not None), 4)

    return out


@router.get("/summary")
def summary(tz: str | None = None, offset: int | None = None):
    """Totals for every session Hermes has recorded, with the splits the row cannot carry.

    Deliberately a SYNC function, not `async def`: the work is blocking sqlite3, and an `async def`
    endpoint runs on the event loop — measured, a request scheduled alongside it waited the full
    489 ms of a cold read, and the app's own session list shares that loop, so opening a session
    pane queued behind this. A sync endpoint is executed in Starlette's threadpool instead, leaving
    the loop free. Do not "modernise" this into `async def` without moving the queries off the loop.

    The day and month boundaries are 00:00 in the caller's timezone (see `zone`), so "today" means
    the user's today. A usage bucket born inside a period burned entirely inside it, so its
    cumulative figures are exact for that period. A bucket that spans the boundary cannot be split exactly — Hermes keeps
    cumulative per-route counters, not per-call rows — so it is apportioned by the share of its
    session's messages that fall inside the period, and a bucket whose last call predates the
    period contributes nothing. Without that split a long-running session reports zero for every
    day after the one it started, which is worse than an estimate.
    """

    tzinfo = zone(tz, offset)
    day_key = lambda ts: _day_key(ts, tzinfo)
    profile_home = Path(get_hermes_home())
    db = _connect(profile_home)

    try:
        db.row_factory = sqlite3.Row
        rows = db.execute(
            """
            select session_id, model,
                   coalesce(billing_provider, '') provider,
                   coalesce(nullif(task, ''), 'main') task,
                   coalesce(api_call_count, 0) calls,
                   coalesce(input_tokens, 0) inp,
                   coalesce(output_tokens, 0) out,
                   coalesce(cache_read_tokens, 0) cache_read,
                   coalesce(cache_write_tokens, 0) cache_write,
                   coalesce(estimated_cost_usd, 0) est,
                   coalesce(actual_cost_usd, 0) act,
                   first_seen, last_seen
            from session_model_usage
            """
        ).fetchall()
        sessions = db.execute("select count(*) from sessions").fetchone()[0]
        covered_by_calls = _covered_by_call_rows(profile_home)
        day_start = _day_start_ts(tzinfo)
        month_start = _month_start_ts(tzinfo)
        weights = _weights(db, day_start, month_start, _window_start(DAILY_WINDOW, tzinfo), day_key)
        day_shares = weights["day"]
        month_shares = weights["month"]
    finally:
        db.close()

    catalogue = _catalogue(profile_home)
    routes = _flex_routes()

    def full(row):
        return _row_cost(row, catalogue, routes)

    def fraction(row, start, shares):
        """Share of one bucket inside the period: all of it when born inside, the apportioned share
        when it straddles the boundary, none when its last call predates it."""
        first = row["first_seen"] or 0

        if first >= start:
            return 1.0

        if (row["last_seen"] or 0) < start:
            return 0.0

        return shares.get(row["session_id"], 0.0)

    def in_period(start, shares):
        """Cost of one bucket inside the period. Claude-plan buckets carry no cost here."""

        def cost(row):
            if _is_claude(row["provider"]):
                return 0.0

            return full(row) * fraction(row, start, shares)

        return cost

    def counted(start, shares):
        """Whether a bucket counts toward the period's calls and sessions. Non-Claude buckets keep the
        rule they always had (a positive cost inside the period); Claude buckets, which carry no cost
        here, count on membership alone."""
        cost = in_period(start, shares)

        def inside(row):
            if _is_claude(row["provider"]):
                return fraction(row, start, shares) > 0

            return cost(row) > 0

        return inside

    def in_period_tokens(start, shares):
        def value(row):
            tokens = (row["inp"] or 0) + (row["out"] or 0) + (row["cache_read"] or 0) + (row["cache_write"] or 0)
            # Tokens of this bucket that call rows already count exactly (added separately, by time).
            tokens = max(0, tokens - covered_by_calls.get(_bucket_key(row), 0))
            first = row["first_seen"] or 0

            if first >= start:
                return tokens

            if (row["last_seen"] or 0) < start:
                return 0

            return int(tokens * shares.get(row["session_id"], 0.0))

        return value

    def period(start, shares):
        cost = in_period(start, shares)
        inside = counted(start, shares)
        tokens = in_period_tokens(start, shares)
        # Exact where per-call rows exist: each call's own tokens, counted by the time it finished.
        # Lifetime tokens no call row covers (usage recorded before those rows existed) keep the
        # prorated figure, so history is never dropped.
        exact = _exact_call_tokens(profile_home, start, covered_by_calls)

        return {
            "calls": sum(r["calls"] or 0 for r in rows if inside(r)),
            "cost": round(sum(cost(r) for r in rows), 4),
            "sessions": len({r["session_id"] for r in rows if inside(r)}),
            "tokens": sum(tokens(r) for r in rows) + exact,
        }

    # Claude-plan cost per session (kept out of every figure above) and the tokens that DO carry
    # priced cost: the desktop's blended rate must divide by these, not by all tokens.
    claude_cost = {}
    all_cost = {}
    priced_tokens = 0

    for row in rows:
        sid = row["session_id"]

        if _is_claude(row["provider"]):
            cost = _claude_cost(row, routes)
            claude_cost[sid] = claude_cost.get(sid, 0.0) + cost
        else:
            cost = _row_cost(row, catalogue, routes)
            priced_tokens += (row["inp"] or 0) + (row["out"] or 0) + (row["cache_read"] or 0) + (row["cache_write"] or 0)

        all_cost[sid] = all_cost.get(sid, 0.0) + cost

    # Claude's share of each session's cost, on the same per-row basis the totals use. The desktop
    # applies this share to the session row's stored cost, so a mixed session keeps its OpenRouter part.
    claude_share = {sid: round(claude_cost[sid] / all_cost[sid], 6) for sid in claude_cost if all_cost.get(sid, 0) > 0}

    return {
        "totals": _sum(rows, full) | {"sessions": sessions, "pricedTokens": priced_tokens},
        # The providers' own reported spend, written by scripts/reconcile_openrouter.py. The local
        # estimate above cannot reproduce OpenRouter's context tiers, per-search fees or vision
        # premiums — measured at 0.94x of its report on this install — so the totals are anchored
        # to what was actually billed and the estimate stays as the breakdown. Null while unknown:
        # DeepSeek's API exposes only a balance, never the spend, so that half has to be typed in.
        "confirmed": _confirmed(profile_home),
        "estimate": round(sum(full(r) for r in rows), 4),
        "claudeShareBySession": claude_share,
        "today": period(day_start, day_shares),
        "month": period(month_start, month_shares),
        "days": _daily_series(rows, weights, DAILY_WINDOW, tzinfo),
        "byProvider": _group(rows, catalogue, "provider", routes),
        "byTask": _group(rows, catalogue, "task", routes),
        "byModel": _group(rows, catalogue, "model", routes),
        "flex": {
            "factor": FLEX_DISCOUNT,
            "models": routes["models"],
            "mults": _flex_mults(rows, routes),
        },
    }
