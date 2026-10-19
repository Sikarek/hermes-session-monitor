# hermes-session-monitor

**v1.1.0** · MIT · macOS · Linux · Windows · [Changelog](CHANGELOG.md)

A live token, context-window, cost and cache-hit monitor for the **Hermes Desktop** app: a figure in the status bar, and the full breakdown in a **sidebar pane** beside your session list. It reports how many tokens the focused session has actually processed (its subagents included), how they break down, how full its context window is, and what they cost — per session, restart-safe, with every figure traceable to a source.

```
202,983,982 tok · 99.82% · $2.1600          the chip, at the right end of the status bar
```

The status-bar figure carries the glance number; **click it** for that detail view right there, or open the **Session monitor** tab beside SESSIONS (also listed in ⌘K) to keep it on screen:

```
Session monitor                                        ↻   the refresh button, at the top right
Context                        421,888 / 1,000,000 · 42%   the window in use
████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   fill = the share of the window in use
Cache hit                                    196,470,400   prompt tokens served from — or written into — the cache
Cache miss                                       353,194   uncached input
Output                                           415,353   everything the model generated, reasoning included
Total                                        197,238,947   this session's own tokens — the three rows above, added up
Subagents                              5,745,035 · $0.3800   the sessions it spawned, and their own subagents
────────────────────────────────────────────────────────
Cache hit rate                                    99.82%   two decimals; Hermes' own item rounds to a whole percent
Cost                                              $2.1600   this session + its subagents, from published rates
```

## What it shows

Two tabs in the sidebar — **Overview** and **Session monitor** — plus the status-bar figure.

The **Overview** totals every session in the profile (subagents included): counters (**Sessions
counted**, **Total requests**), then a token section (**Daily tokens**, **Monthly tokens**,
**Total tokens**), then a cost section (**Daily cost**, **Monthly cost**, **Total cost**) — a hairline
divides the three sections. (Requests are counted as they are *observed*: the session row carries only tool calls, and the authoritative per-session request total lives in a table the app side cannot read, so this figure counts every request reported since the app started — the Python half would be needed for a historical total.) **Daily** and **Monthly** come from the backend half and are period-attributed: a usage bucket
  whose first call falls inside the period counts in full (it burned entirely inside it), one whose
  last call predates it counts for nothing, and one that *spans* the boundary is apportioned by the
  share of its session's transcript that falls inside the period. Live growth observed while you
  watch is then added on top. Without the backend half both are observed-only from load. **Daily
  resets at 00:00 UTC, Monthly at 00:00 UTC on the 1st** — the same clock as the chart below.

Below them, a **per-day bar chart** of the last 30 days: each bar is that day's tokens scaled against
the window's peak, today drawn in full contrast, and a day with no usage left as a faint 2px stub.
**Pointing anywhere in a day's column reads that day out underneath it** — the date on the left, the
token count on the right — and lights the bar, so a day whose bar is two pixels tall is as easy to
read as the peak. The same line states the window's ends ("`Aug 21 UTC` — `Sep 19 UTC`") while the
pointer is away; no floating tooltip, so nothing covers the pane.

## Which day is "today"

Every period — the **Daily** and **Monthly** resets and the **chart's bars** — is cut at **00:00 in
your own timezone**, not the server's and not a fixed UTC. The desktop side knows the real zone (it
runs on your machine) and tells the backend with each read; the backend prefers the named zone so a
daylight-saving shift is followed, falls back to the current UTC offset if the runtime has no tz
database, and to its own local clock if it is told nothing at all.

That matters more than it sounds. This is a cumulative-counter database, so a day boundary decides
which bar — and which "today" — a call lands in, and the size of the effect is large: measured on
this install the same calendar day holds `1,343,080,482` tokens cut at a Bangkok midnight and
`1,794,678,555` cut at UTC's, because an evening in one zone is still the previous afternoon in the
other. The chart's dates therefore carry the zone they were cut in (`Aug 21 GMT+7` … `Sep 19 GMT+7`)
so two figures can never be compared without knowing which clock produced them.

Both totals climb while any session runs — every running session's completed calls are counted as their ticks land, and the streamed text of the session in front of you is counted word by word — and each session's live portion is dropped as its own row is written, so nothing is counted twice. A `~` marks a figure still carrying an in-flight estimate; it disappears once the rows account for it, which is the confirmation, per row. The focused **Session monitor** tab is unaffected by other sessions' activity.


| Row                      | Meaning                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context**        | Tokens currently in the window / the model's window, and the share in use, above a fill bar. Read from the same live usage payloads as the totals. |
| **Cache hit**      | Prompt tokens served from — or written into — the provider's cache (`cache_read + cache_write`).                                               |
| **Cache miss**     | Uncached input tokens.                                                                                                                             |
| **Output**         | Every token the model generated, reasoning included.                                                                                               |
| **Subagents**      | Tokens and cost of the sessions this one spawned — and of their own subagents — summed from the same page via `parent_session_id`. Shown only when there are any, and outside the partition above. |
| **Cache hit rate** | `cache_read ÷ prompt tokens`, to two decimals. Hermes' own status-bar item rounds this to a whole percent, which flattens 99.79% to "100%".     |
| **Cost**           | The cost Hermes recorded for this session — see[Cost](#cost) for how it is derived and how accurate it is.                                         |

The three token rows **partition** the session total: `cache hit + cache miss + output` equals the **Total** row shown beneath them exactly, so no token is counted in two rows. The rows carry no percentages — the Total beneath them states the partition, and the cache ratio is the **Cache hit rate** figure below the rule.

The number moves **while the model works**: streamed reasoning and reply text are counted chunk by chunk as they arrive, and each completed API call snaps the total to the provider's reported figure.

## The backend half (historical totals)

The pane reads the app's **session rows**, which carry no request count and no per-model split. Both
live in `session_model_usage`, which only the Python side can reach — so the repository ships a small
backend plugin that exposes them read-only at `/api/plugins/session-monitor/summary`:

```
totals:   26,112 requests · 6,364,280,802 tokens · $96.8663 · 276 sessions
today:    1,203 requests ·   42,233,892 tokens ·  $0.7096 · 3 sessions   (00:00 your time)
month:   11,910 requests · 3,241,124,134 tokens · $63.7872 · 139 sessions (from the 1st)
byProvider / byTask / byModel     (whatever that table holds)
```

**Cost in this half is re-priced, not just re-read.** A recorded estimate is computed when the call
happens and never revised, so it keeps the rates of that moment and drifts below the catalogue once
a price rises; on this install that alone made the Overview read about 20% under. For OpenRouter
rows the recorded tokens are therefore valued at OpenRouter's own catalogue price from the local
cache Hermes already keeps, and a route with no catalogue entry keeps its recorded estimate rather
than becoming zero.

**Flex-pinned routes are priced as flex.** Pin a model to OpenRouter's `openai/flex` endpoint
(`provider_routing.models.<id>.only: [openai/flex]`) and the invoice halves — flex is measured at
exactly 0.5× the standard rates on every token bucket — while Hermes records its estimate at
standard rates (measured against OpenRouter's own charges: 2.0001× on `openai/gpt-6-luna`, 2.0×
on `openai/gpt-5.6-sol`). Every cost this plugin derives is therefore scaled by the flex
multiplier the pin guarantees: the Overview inside the re-price, the panel and the chip from the
`flex.mults` map `/summary` carries per session (estimated-cost weighted, since one session can
mix pinned and unpinned models). What it cannot know: WHEN a model was pinned — the config keeps
no history — so usage from before a pin also reads at flex rates (on this install, $1.62 of
August `gpt-5.6-luna-pro` usage; only the all-time totals can show it).

The rate used is the one the bucket's **own hours** hit, averaged across the catalogue's price
windows. OpenRouter prices some models by time of day and day of week and reports whichever window
is *active* as the base price, so `deepseek/deepseek-v4.1-flash` reads `$0.30/M` at 09:00 UTC and
`$0.15/M` at 14:00 UTC — weekday 01:00–04:00 and 06:00–10:00 UTC run at twice the price. Reading
that field directly would make history swing 2× with the clock, so it is not read; but charging
every hour the **highest** window was wrong in the other direction, since most hours are cheap. A
bucket's `first_seen`→`last_seen` span is fixed the moment its calls are recorded, so the windows are
averaged over that span: stable, and no longer biased upward. With no span to go on the highest
window is kept, as the bound that cannot read below the invoice.

Measured against the same account's OpenRouter figure (`/api/v1/credits`, all-time `$106.91`): the
profile's OpenRouter rows re-price to `$122.33`, where the peak rule gave `$144.74` — the `$22.38`
between them is the peak rule alone. The remaining `~$15` is the **token count, not the rate**: even
at the cheapest rate the catalogue lists, those same rows come to `$115`, so something records more
tokens than OpenRouter bills for. What that is needs OpenRouter's per-model activity rows, which
require a management key (`/api/v1/activity` refuses a normal one), so it is stated as an open gap
rather than explained away. The total shown also *includes* whatever other providers you bill
directly (DeepSeek, here), which the OpenRouter figure does not.

**DeepSeek is priced from DeepSeek's own table**, not from a recorded estimate: the estimate kept
the rates of the day the call happened to hit a stale catalogue (verified — `deepseek-v4-flash`'s
recorded `$9.515` is exactly its tokens at DeepSeek's pre-2026-08-16 prices), and one model had no
rate at all. The published schedule has an off-peak and a peak rate (twice as much on weekdays
01:00–04:00 and 06:00–10:00 UTC) and changed on 2026-08-16, so a bucket is split at that date and
blended across the hours it was alive. The same table prices OpenRouter's `deepseek*` rows: those
ids are billed at DeepSeek's schedule (OpenRouter's catalogue published exactly these windows until
its 2026-10-08 refresh dropped them), and the vendor prefix is stripped before matching.

**Claude-plan traffic is excluded from cost, never from tokens.** `anthropic` and
`claude-subscription-directsdk-experimental` run on a separate subscription, so their cost is
dropped from every figure and their tokens are kept — the Overview reports `pricedTokens` beside
`tokens` for exactly this split.

Measured against the providers' own reports, all three cut in UTC (`scripts/reconcile_openrouter.py`
prints this table on demand):

```code
same window      OpenRouter says   the monitor   ratio
today                 $2.58         $2.24       0.87x
this month            $3.85         $2.96       0.77x
all-time            $129.90       $119.40       0.92x
```

**The headline `Total cost` is the providers' own figure once it has been reconciled**, not the
local estimate. `scripts/reconcile_openrouter.py` writes what OpenRouter *actually reported* (its
`/api/v1/credits` total) into `~/.hermes/session-monitor-anchors.json`; DeepSeek's half is typed in
with `--deepseek-amount <USD>` because their API exposes only a balance, never the spend. The row
then shows that total, dated, with the estimate kept underneath as the part attributed to sessions.

**Nothing is pulled from the providers on restart or update.** Hermes re-reads the anchors file on
every request, so a restart shows exactly what the last reconciliation recorded — the token and cost
*estimates* stay live because they come from `state.db`, but the confirmed total is a snapshot until
the script runs again. A scheduled job (cron `session-monitor cost anchor`, every 6h,
`~/.hermes/scripts/refresh_cost_anchor.sh`) keeps it moving; it refreshes OpenRouter's half and
**keeps** a DeepSeek figure typed in earlier, and stays silent unless it fails. Pause or drop it with
`cronjob_manage` (job `f1ab624e7739`) if you would rather run it by hand. Plugin files under
`~/.hermes/desktop-plugins/` and `~/.hermes/plugins/` are untouched by `hermes update`, so the
plugin survives updates.

This matters because the two differ by more than fees: the estimate can only value tokens Hermes
recorded, so anything billed outside this database is invisible to it. Measured on this install,
reconciled 2026-10-16: the providers report **$216.01** (OpenRouter $145.83 + DeepSeek $70.18) while
the recorded tokens account for **$113.02** — the difference is mostly DeepSeek usage from before
this database tracked it, plus OpenRouter's per-call charges. Nothing is invented: unknown reads as
blank, and a total that has not been reconciled still shows the estimate.

It still cannot be exact: OpenRouter charges things that are not a token × rate — context tiers above
a threshold, and per-search fees (`$0.01` a search on some models) — none of which any local table can
attribute to a cumulative counter. The rows are also blended uniformly across the hours a bucket was
alive, while real traffic clusters in working hours (which are DeepSeek's *peak* windows), so the
blend reads slightly low. The one measurement that would close it is OpenRouter's per-model activity
(``/api/v1/activity``, which needs a management key).

Install it alongside the app half (same id, so the pane's own REST namespace resolves):

```bash
cp -r hermes-session-monitor/plugins/session-monitor ~/.hermes/plugins/
```

then allow its Python to run — user plugins are gated behind `plugins.enabled` in
`config.yaml`, deliberately, so an installed-but-unenabled plugin cannot execute at startup:

```yaml
plugins:
  enabled: [session-monitor]
```

**Cost of a read.** The endpoint is polled every 5 seconds while the Overview is open, so it is
built to be cheap: the message-derived weights it needs (the character timeline a bucket's tokens
are spread by) are computed in **two passes and cached for 20 seconds**, keyed by the day/month/window
boundaries. Measured here: **~500 ms cold, ~30 ms warm** — before the cache it was ~850 ms on *every*
call, because each `length()` over the message table costs ~200 ms and the endpoint needed four
passes. The live part of the display does not come from that poll at all; it rides the event
subscriptions, so a slow or failed read costs accuracy, never freshness.

**Why the endpoint is a sync function, not `async def`.** The work is blocking `sqlite3`, and an
`async def` endpoint runs *on the event loop* — so while it worked, every other request the backend
was serving queued behind it. Measured: a request scheduled alongside a cold read waited **489.4 ms**
against the read's own 489.3 ms, and the app's session-list request shares that loop, which is why
opening a session pane felt slow when this backend half arrived (the version before it made *no*
REST calls at all, hence the instant load). As a sync endpoint Starlette runs it in a threadpool:
the same concurrent request now waits **2 ms**. If you ever move this handler back to `async def`,
move the queries off the loop at the same time — `selftest.py` fails if it goes back.

**A session switch does not touch the backend half.** The summary is profile-wide — it does not
depend on which session is selected — so it is read **once per view mount** and then kept fresh by
the Overview's own loop. It used to ride every session change (one read per mounted view: three, in
a window with the chip, the pane and the Overview open), and each of those is up to ~580 ms of
backend work, which is what made switching feel slow.

**A switch repaints the context window it already knows.** The Context row is the slowest thing the
pane asks for — `session.context_breakdown` is estimated by the backend from the live prompt, tools
and transcript — so it used to blank the row and wait for a fresh estimate on every switch. The last
figure each session reported is remembered for the life of the app run and painted immediately, with
the read running behind it; the stamp check still guarantees one session's window never appears under
another's name.

**A switch repaints the totals row it already knows.** The Cache hit / Cache miss / Output /
Total / Cost row is remembered per session the same way the Context row is. It used to be cleared
on every switch while a fresh session-list read ran — and that read can miss for seconds (the
session is not in the loaded page of the paginated list) or fail, so the panel showed **zeros**
for a session whose figures it had already displayed, until the read landed or the next poll
found the row ("it resets everything to zero... it happens every time I switch the session
window"). A switch now paints the remembered row immediately and the read refreshes it behind;
a session never seen before in this app run still starts empty.

**When a read fails**, the last good totals stay on screen — the Overview switches to its
page-of-rows fallback only after three consecutive failures, and a later success lands back on the
same figures. Clearing them on the first hiccup made the totals visibly jump between two bases
(recorded estimates vs re-priced), which read as the pane being buggy.

Restart the backend (or the app) once. Without this half the Overview falls back to the page of
rows it can read itself — same tabs, fewer sources. With it, the Overview's totals are Hermes' own
record over every session, every provider and every model.

## Install

macOS / Linux:

```bash
git clone https://github.com/Sikarek/hermes-session-monitor.git
mkdir -p ~/.hermes/desktop-plugins
cp -r hermes-session-monitor/session-monitor ~/.hermes/desktop-plugins/
```

Windows: copy the `session-monitor` folder to `%LOCALAPPDATA%\hermes\desktop-plugins\session-monitor\`.

No build step and no backend changes. The app watches that folder, so the chip appears within a second; if it doesn't, press ⌘K → **Reload desktop plugins**.

**Uninstall:** `rm -rf ~/.hermes/desktop-plugins/session-monitor`. The plugin writes nothing outside its own folder — no config keys, no stored data.

## Usage

| Action           | Where                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Chip             | Right end of the status bar — click it for the detail box |
| Detail pane      | **Session monitor** tab beside SESSIONS in the left sidebar (⌘K lists a toggle) |
| Refresh          | **↻** at the top right of the pane — re-reads the stored session row now instead of waiting for the next poll |
| Hide / show      | Right-click the status bar →**Session monitor**                                                                 |
| Disable entirely | Settings → Skills → Plugins →*Session Monitor* → Desktop switch                                                  |

## How it works

The total is assembled from three sources, in this order:

| Term            | Source                                                                                                                                                                                                                         | Survives a restart                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Base total      | `host.listPersistedSessions()` → `GET /api/profiles/sessions` → the profile's `state.db` session row                                                                                                                   | Yes — it is the stored row                                |
| Completed calls | `session.usage` events, attributed strictly to this window's focused session. The payload is that process's cumulative counter, so the first tick of a plugin lifetime is a **baseline** and growth is counted from it | No (process-local), but only ever added on top of the base |
| Live text       | `message.delta` (answer) and `reasoning.delta` (thinking), counted as they stream                                                                                                                                          | No — superseded by the next completed call                |

- **The base uses Hermes' own definition** — `input + output + cache_read + cache_write`, the same "Total tokens" as `agent/insights.py`. Reasoning is a detail *inside* `output` and is never added separately.
- **Which session it describes** — the **focused session**: the one the desktop reports as current, which is what the figures actually follow (keying on `activeSessionId` instead pins the context figure to one session for every session, reproducibly — `PREFER_ACTIVE_CHAT` at the top of the plugin switches it in one line). If a build moves focus when you interact with something in the sessions strip, the readout follows that focus; the pane therefore lives in its own zone rather than as a tab in that strip.
- **Per-session isolation** — every term is attributed by session id (the focused session's runtime id or its stored id). There is no fallback that accepts unknown ids, so another session's events can never enter this chip.
- **The stamp and the test that reads it must consult the same ids.** The stamp is written from the
  id a row read *adopts* (the read rewrites it when it resolves the session on screen); the test used
  to compare against the app's stored-id *atom* instead. Wherever those disagree — the usual state for
  a second or two after a restart, while the atoms settle — a window measured for the session was
  stamped with one id and checked against another, which shows as an empty Context row.
- **The context window is stamped with both identities, and either one matching is enough.** The
  window is the one figure with no identity of its own — it is read from a payload that could have
  been measured for anything — so it is stored with the session it was measured for. That stamp used
  to be the runtime id alone, which is the wrong half to rely on: a resumed session runs under a
  **new** runtime id while its stored id stays, so a figure measured for it (pushed before the
  window's own atoms caught up, or relayed) carried a stamp that no longer matched and the row
  stayed blank — the "context window is glitchy and doesn't show up for some session" report. The
  stored id is per-session and stable, so it carries the guarantee the strict check was after: a
  payload for a *different* session is still dropped on its stored id before it can paint.
- **Restart-safe** — the agent's live counters are process-local and restart at zero, which is why a live-only counter appears to reset; the stored row does not.
- **Subagents are counted, on their own line** — their tokens live in their own session rows, which is why the partition above is this session's own. The panel adds a `Subagents` line (tokens · cost) and the chip's total and cost include them, summed transitively from the same page (a subagent that spawned its own is still this session's). Their *live* ticks are still refused — they carry the child's session id, and accepting unknown ids is what once let another session's work inflate this chip — so the figure updates when a child writes its row, i.e. at the end of its own turn.
- **The Context row is live, not stored** — it comes from `context_used` / `context_max` / `context_percent` on those two event payloads, and — when nothing has been pushed yet — from an on-demand `session.context_breakdown` read addressed to this window's session id, so a panel opened on an idle session is never blank. The backend rejects the read for a runtime id it no longer holds (a detached or reaped session), so it is retried briefly and then re-asked by the poll and on every session change, instead of being fired once and forgotten. A `~` marks the figure the backend calls estimated. The window follows the model: switching models clears it (the row reads `—` rather than the previous model's limit) and triggers a fresh read.
- **The counter's baseline** — `session.usage` carries the agent *process's* cumulative counter for the session, while the stored row accumulates across processes, so the row already contains most of that counter. The first tick a plugin lifetime sees is therefore taken as a baseline (claiming it as growth would inflate the chip by everything the process had written), and a clearly regressed counter — an agent restart — rebases the same way instead of freezing. After a reload the chip therefore starts from your stored total and grows from there.
- **One history per window** — every view of a window shares one set of accumulators (the live counters, the anchor, the high-water mark, the streamed characters) and one set of displayed values, and only the first mounted view subscribes and polls. A view is mounted only while it is on screen: the sidebar pane's tab unmounts with the tab, and the status-bar item can be hidden. Per-view state therefore gave a freshly opened pane an **empty history** — it recomputed the session's figures without the live counters the other view had accumulated, which is why opening the pane could show different values than the chip. The request guards are shared with the state, so a read issued by one view cannot write stale figures into the store the other is showing.
- **Every read is tagged and checked before it lands** — a response is applied only if it is still the newest request *and* still belongs to the session on screen. Reads are async, so a slow one issued first (a refresh racing the poll, or a session switch mid-read) used to land last and paint its row into the current view, where it stayed until the next read. Now a stale response is discarded instead of displayed.
- **Reads never disturb the live term** — the anchor the live counter is measured against only advances when the *stored row* does, i.e. when a turn ends and is written. Reading the row (the 15-second poll, or the refresh button) therefore leaves the growth already counted in place; refreshing mid-turn cannot stall the counter.
- **Resumed sessions re-attach on their own** — a resumed session runs under a new runtime id; its own `session.info` (which carries the stored id, so it is proof rather than a guess) teaches the chip that id, and the live ticks are attributed again. Without that step the counter would freeze until the window's own state refreshed.

## Cost

Cost is **read from the session row, not recomputed**: Hermes prices each call as

```
input × in_rate + output × out_rate + cache_read × read_rate + cache_write × write_rate   (per 1M tokens)
```

and the result is stored per session. Rates come from Hermes' price map — `official_docs_snapshot` for Anthropic and OpenAI, `provider_models_api` (models.dev, cached) for OpenRouter and DeepSeek — with per-request prices and context tiers where a provider publishes them.

**Live estimate.** The recorded figure only changes when the row is written (turn end) or re-read (the 15-second poll), so a turn in progress used to show a flat cost while the tokens climbed. While a call is in flight the in-flight tokens are now priced at the row's own blended rate — its cost over its tokens — and the figure carries a `~`; the marker goes as soon as the recorded value accounts for them. That rate **understates** two cases, so it lags rather than overshoots and every read corrects it: an **output-heavy call** (cache-read tokens cost a fraction of generated ones, and the row carries no per-bucket cost), and a session that has **used models at different rates** — the blended rate is the row cost over the row tokens, so free-tier tokens in the history dilute it. A session spanning eleven models (several free) has a rate far below its current model's and the live figure trails until the recorded value lands.

**In the Overview, cost is re-priced rather than re-read.** The session panel and the chip show
`estimated_cost_usd` exactly as Hermes stored it, scaled only by the session's flex multiplier
(see below). The Overview's three cost rows come
from the backend half, which values each recorded bucket's tokens at the rates the bucket's own
calls were subject to: the catalogue's price windows averaged over its `first_seen`→`last_seen`
span, and the long-context tier its own call sizes select (a `min_prompt_tokens` premium is NOT
a time window — reading it as one doubled every long-context model's cost) — because a stored
estimate is fixed at the moment of the call and drifts below a price that later rises, while the
catalogue's base field is itself whichever window is active. For OpenRouter routes that price comes
from OpenRouter's own catalogue entry in the local cache; a route with no entry keeps its recorded
figure. Per-search fees stay out of both figures.

**Accuracy.** Three consequences follow from that design:

- The value is an **estimate from published rates**, not the provider's invoice — they can differ.
- `estimated_cost_usd` is a **standard-rate** figure even for flex-pinned routes (measured: 2.0×
  against OpenRouter's own charge), so the panel scales it by the flex multiplier the backend half
  computes — the panel shows the flex price wherever the pin guarantees one. A recorded
  `actual_cost_usd`, when it exists, is never rescaled.
- Reasoning tokens are priced at the model's **output rate**. On the few models that publish a different reasoning rate, the estimate is off by the difference.
- OpenRouter reports a real per-generation charge, but not through any data a plugin can read, so it is not used.

## Privacy & security

The plugin displays numbers the app already has. It makes **no network requests of its own, writes nothing, and never reads your conversation.** The complete surface — four state atoms, four event subscriptions and two reads — is listed below and can be verified line by line: the source ships unminified.

| Host call                                                   | Purpose                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `host.state.focusedStoredSessionId`                       | Which session this window is showing                                                                                                |
| `host.state.focusedSessionId`                             | Its runtime id                                                                                                                      |
| `host.state.focusedSessionProfile`                        | Its profile                                                                                                                         |
| `host.state.model`                                        | The model in use — the context window belongs to it                                                                                |
| `host.onEvent('session.usage')`                           | Completed-call token totals and the context window                                                                                  |
| `host.onEvent('session.info')`                            | The same usage snapshot when a session is opened or resumed                                                                         |
| `host.onEvent('message.delta')`                           | The answer's streamed text (measured, not kept)                                                                                     |
| `host.onEvent('reasoning.delta')`                         | The reasoning's streamed text (measured, not kept)                                                                                  |
| `host.listPersistedSessions()`                            | The focused profile's session rows — the figures displayed                                                                         |
| `host.request('session.context_breakdown', {session_id})` | The context window for THIS session's id (an estimate from the live prompt + tools + transcript: no provider call, no cache impact) |

**It does not:**

- **transmit anything** — no telemetry, no analytics, no provider call, no third-party endpoint. Every read goes through the app's own local backend.
- **read your conversation** — streamed text is measured with `.length` and dropped. No prompt, message body, or tool result is read, stored or displayed, and there is no transcript access at all (`session.history` is not called).
- **store data** — nothing is written to disk or browser storage, and there are no settings to persist.
- **touch credentials** — `.env`, config files, API keys and tokens are never read.
- **collect subagent data** — child sessions have their own rows, and their relayed text carries the child's session id, which the id filter excludes.

Verify each claim from the repository root:

```bash
cd session-monitor

# 1) no network, storage, filesystem or process access anywhere in the file
grep -nE "fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|ctx\.storage|process\.|require\(" plugin.js
#    → no output

# 2) every host call site, with its count
grep -oE "host\.(onEvent\('[a-z.]+'|state\.[a-zA-Z]+|listPersistedSessions|request)" plugin.js | sort | uniq -c
#    → 3 host.listPersistedSessions          (1 call + 2 comment mentions)
#    → 3 host.request                          (1 call + 2 mentions: the docstring
#                                             and the typeof guard)
#    → 1 host.onEvent('message.delta'
#    → 1 host.onEvent('reasoning.delta'
#    → 1 host.onEvent('session.info'
#    → 1 host.onEvent('session.usage'
#    → 1 host.state.focusedSessionId
#    → 1 host.state.focusedSessionProfile
#    → 1 host.state.model
#    → 1 host.state.focusedStoredSessionId
#    → 2 host.state.focusedUsage             (2 comment mentions only: both record
#                                             that the fused atom is deliberately
#                                             NOT used, so sessions cannot bleed)

# 3) no transcript or message-content access
grep -cE "session\.history|\.content\b" plugin.js
#    → 0

# 4) streamed text is measured, never kept
grep -n "text.length" plugin.js
#    → chars.current += text.length        the counter
#    → chunk: text.length                  debug log, off by default (DEBUG)
```

**One platform caveat, stated plainly:** a Hermes desktop plugin is **not sandboxed** — it runs with the app's privileges, so a plugin *could* do more than this one does. The host restricts which modules a plugin may import, not what it may then call — which is why the surface above is kept small and documented rather than assumed.

**Failures are contained.** The chip wraps its own render in an error boundary, so a bug inside it degrades to `— tok` instead of reaching the app's root boundary.

## Compatibility

- **macOS, Linux, Windows** — plain ESM using only the plugin SDK, React and standard web APIs (`setInterval`, `requestAnimationFrame`, `Intl` number formatting). No Node APIs, no shell commands, no OS-specific paths or calls; the plugin file is identical on every platform, only the install path differs.
- **Hermes Desktop** — any build providing the status-bar contribution area and `host.listPersistedSessions`. On an older backend without the session read, the chip falls back to the live counters rather than inventing a total, and says nothing about it — the readiness gate still holds the digits until a row resolves, so no wrong figure is ever painted.
- **Remote gateways** — the plugin root is resolved locally, so the chip still loads when the window is connected to a remote or cloud gateway.

## Known limitations

- **Main task only.** The session row does not include auxiliary work attributed to the same session (background review, title generation); that data lives in `session_model_usage` and is not reachable from the app side, so it is not shown.
- **Cache hit includes cache writes.** A write is a miss being cached — priced above plain input, counted as a hit on the next call. It is 0 on routes without explicit caching (DeepSeek, OpenRouter), so on Anthropic this row includes a portion that was not strictly a hit.
- **Live text is an estimate.** Streamed text is counted at ≈4 characters per token until the call's real total arrives, after which the estimate is replaced.
- **Subagent figures arrive at their turn ends.** A child writes its row when its own turn finishes, and the pick-up is the same 15-second poll; a subagent still running is not counted yet. Sessions beyond the fetched page (500 rows) are not seen.
- **The chart is an estimate per bar, weighted by transcript volume.** A usage bucket records only
  when it was first and last written, so a day's figure is apportioned by how much *text* that
  session moved that day (content + reasoning characters, ÷4 ≈ tokens). Characters, not message
  counts: three terse turns and one 12,000-character tool result are one message each, while the
  second costs orders of magnitude more, and a count-based split put a bucket's tokens on the chatty
  day instead of the expensive one. It is still an estimate — a day whose cost came from one huge
  cached call among many small ones is smoothed toward its neighbours. Days before the 30-day window
  are not drawn, and a bucket older than the window contributes only its in-window share.
- **Daily and Monthly are period-attributed estimates.** A bucket born inside the period counts in
  full; one that ended before it counts not at all; one that spans the boundary is apportioned by
  how many of its session's messages fall inside the period — a proxy, since message counts are not
  token counts. Without the backend half (or before it answers) they count only activity observed
  since load. Both reset on the next midnight in your timezone that the monitor sees.
- **The context window is the provider's figure.** It is the size of the prompt for the last call (plus what the backend adds), so it can read lower than the session total — the session total counts every call, the window counts what is in context right now.

## Development

The plugin is one plain-ESM file: no build step, hot-reloaded on save.

**Two checks before installing an edited copy:**

```bash
# 1. static — TypeScript over the plugin, using the binary from a Hermes source
#    checkout (a plugin-only clone has no node_modules). Catches undeclared names and
#    use-before-declaration; both shipped a bug during development — an undefined
#    identifier that made every usage tick throw, and a callback referencing a
#    binding declared below it. The only output to expect is the module-resolution
#    noise for `@hermes/plugin-sdk` and `react`, which are stubs at this point, plus
#    one `TS2339` on `this.props` inside the error-boundary class — React's own types
#    live in the app, not here, so that property cannot be resolved from outside.
"$HOME/.hermes/hermes-agent/node_modules/.bin/tsc" --allowJs --checkJs --noEmit \
  --target esnext --moduleResolution bundler --skipLibCheck --noImplicitAny false \
  --strictNullChecks false session-monitor/plugin.js

# 2. behavioural (renderer half)
node session-monitor/smoke.mjs

# 3. backend half — re-pricing, period apportionment, the today ≤ month ≤ total ladder
~/.hermes/hermes-agent/venv/bin/python plugins/session-monitor/dashboard/selftest.py
```

### What the mount test covers

It stubs the SDK, mounts the chip against a real React root inside an error
boundary, and fails on render *and* effect-time errors (`node --check` cannot see
an undefined identifier, and an uncontained throw reaches the app's root boundary,
which blanks the window).

Behaviour — a streamed chunk moves the total by exactly `chars ÷ 4`; the first tick
is taken as a baseline and growth after it is counted; a manual refresh does not move
the displayed total and counting continues afterwards; a row advance neither
double-counts nor drops tokens and counting resumes from the new anchor; a process
cumulative does not inflate the total; the context row paints from an attributed
payload, its bar matches the reported percent, a refresh re-pulls it, and a rejected
pull is retried; the refresh button performs a fresh read; the labels/figures contrast
rule and the percentage-free rows hold; the popover width contract holds.

Isolation — two simulated windows keep separate totals; a foreign session's tick,
context payload or text is refused; a tick from a resumed runtime id IS adopted
(its own `session.info` taught the chip that id).

Edge cases — each is a situation the chip meets in the field:

| Situation                                                                  | What must happen                                                                                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A draft with no session yet (`null` ids)                                 | Renders, reports that no stored row exists                                                                                                            |
| The stored-row read throws (backend hiccup)                                | Live counting keeps working                                                                                                                           |
| An older build without`host.listPersistedSessions`                       | Mounts and degrades, never throws                                                                                                                     |
| An older SDK without`Button` or the icon set                             | Still renders a working refresh control (plain button +`↻`)                                                                                        |
| A provider that bills cache writes                                         | `Cache hit` = read + write, and the total includes both                                                                                             |
| A garbage payload (`null`, missing fields, non-numeric, negative, 10^15) | Nothing invalid is painted — no`NaN`, no `undefined`                                                                                             |
| A session switch inside one window                                         | The new session takes over; the abandoned one stops counting                                                                                          |
| A switch back to a session already shown, with the row read slow or missing | The remembered totals row paints immediately — never zeros while the read is pending or failing                                                      |
| A model switch                                                             | The context window clears and a fresh read is triggered                                                                                               |
| A panel opened on an idle session, nothing pushed yet                      | The window is fetched on demand instead of staying blank                                                                                              |
| A session the gateway no longer holds in memory (detached / reaped)        | The pull is rejected, one retry + the poll keep asking, and the row says`—` rather than a stale number; it fills in when the session is live again |
| A session switch, or a resume whose runtime id arrives late                | The window is re-pulled for the new session id                                                                                                        |
| A plugin mounted mid-session (a process cumulative far above the row)      | The total stays correct — the first tick is a baseline, not spend                                                                                    |
| A manual refresh (or the 15 s poll) while the model works                  | The live term survives; the counter keeps climbing, and a row advance is not counted twice                                                            |
| A slow read landing after a newer one (refresh racing the poll, or a session switch mid-read) | Dropped: the newest read for the session on screen wins |
| A view mounting after another has been running (opening the pane's tab) | It shows the same figures — one history, one set of values, per window |
| A context figure measured for another session | Never displayed: it is stamped, and shown only while the stamp matches the session on screen |
| Interacting with the sessions strip (a build that moves focus there) | The readout follows the focus; the pane is deliberately not docked in that strip |
| Clicking elsewhere in the sidebar (focusing another tile or project) | The monitor stays on the chat on screen, not the last thing clicked |
| A deliberately broken copy of the plugin                                   | The error boundary contains it; the app root is never reached                                                                                         |

Every assertion above was mutation-checked: reintroducing each bug makes the suite
fail with a message naming it (verified for the undefined identifier, the
use-before-declaration, a removed numeric guard, dropped cache writes, the missing
refresh button, a missing event subscription, and a model switch that leaves the
old window on screen).

## License

MIT — see [LICENSE](LICENSE).

Author notes: this is my first public repo, i built it because i want to see my realtime token usage, and i think other people might find it useful too :)
