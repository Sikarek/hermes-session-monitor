# Changelog

Chronological record of this plugin: everything the development phase added and
changed (**Pre-1.0.0**), then the first public release (**1.0.0**).

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## Unreleased

- **The cost anchor refreshes itself.** A scheduled job (`session-monitor cost anchor`, every 6h)
  re-runs `scripts/reconcile_openrouter.py`, so the confirmed total tracks OpenRouter's invoice
  instead of freezing at whatever it said when last run by hand. The script now merges rather than
  overwrites: a DeepSeek figure typed in earlier survives a refresh (their API can never supply it).
  Restarting Hermes re-reads the anchors file on every request but never fetches — nothing pulls from
  the providers on its own.

---

## Unreleased

- **`Total cost` now shows the providers' own reported spend once reconciled.** The estimate cannot
  reach it: it only values tokens Hermes recorded, and misses usage billed outside this database.
  Measured 2026-10-16 — OpenRouter $145.83 + DeepSeek $70.18 = **$216.01** against $113.02 of
  recorded tokens, the difference being mostly DeepSeek platform usage from before this database
  tracked it. `scripts/reconcile_openrouter.py --deepseek-amount <USD>` writes both figures into
  `~/.hermes/session-monitor-anchors.json`; the Overview then shows that total, dated, with the
  estimate underneath as the part attributed to sessions.

---

## Unreleased

- **A `Confirmed (providers)` row in the Overview.** The cost figures are estimates (recorded
  tokens × price tables) and were measured at 0.94× OpenRouter's own report — and at 0.77–0.87× on
  the day and month windows — because OpenRouter bills context tiers, per-search fees and vision
  premiums that no token × rate reproduces. Every local cause was ruled out by measurement (stale
  prices +$0.22, reasoning tokens already inside output, no usage missing from the rows, the flex
  discount removing $0, unlisted models unbilled). `scripts/reconcile_openrouter.py` now writes the
  providers' OWN totals to `~/.hermes/session-monitor-anchors.json` and the Overview shows that as
  the one non-estimate figure, dated, with its gap against the estimate. DeepSeek's half stays null
  until typed in (`--deepseek-amount`): their API exposes only a balance, never the spend.

---

## Unreleased

- **Claude-plan cost stays out of every figure, its tokens stay in.** `anthropic` and
  `claude-subscription-directsdk-experimental` are billed to a separate subscription, not this
  ledger, so their cost is dropped from the chip, the session pane and every Overview figure while
  their tokens still count. (Live since the previous round; confirmed working on the served
  endpoint: those two providers read `$0.00`.)
- **DeepSeek rows are priced at DeepSeek's own published schedule.** The recorded estimate used
  DeepSeek's **pre-2026-08-16** rates (verified: `deepseek-v4-flash`'s $9.515 is exactly its tokens
  at the old $0.14/$0.28/$0.0028 table), one model had no rate at all ($0.00 for 24.5M cached
  tokens), and OpenRouter's catalogue no longer publishes the peak windows. Now both providers'
  `deepseek*` rows — including the prefixed `deepseek/deepseek-v4.1-flash`, 2.9B tokens — are priced
  at the published table: the 2026-08-16 change splits a straddling bucket, and the weekday peak
  windows (01:00–04:00 and 06:00–10:00 UTC) at twice the off-peak rate. Measured effect: the
  all-time figure moves from 1.09× OpenRouter's own report to **0.92×** ($119.40 vs $129.90).

---

## Unreleased

- **A session switch no longer zeroes the totals row.** Switching sessions cleared Cache hit /
  Cache miss / Output / Total / Cost and waited for the session-list read — which can miss for
  seconds (the session is not in the loaded page of the paginated list) or fail, so the panel
  showed zeros for a session whose figures it had already displayed until the read landed ("it
  resets everything to zero... it happens every time I switch the session window"). The row is
  now memoized per session, exactly like the Context row: a switch paints the figures the session
  reported earlier in this app run and the read refreshes them behind. A session never seen
  before in this app run still starts empty.

- **Cost is now charged at the rate each bucket's own hours hit.** OpenRouter prices some models by
  time of day and day of week (`deepseek-v4.1-flash` runs at 2× on weekday 01:00–04:00 and
  06:00–10:00 UTC) and reports whichever window is active *now* in its `prompt`/`completion` fields.
  The Overview used to value history at the **highest** window, which is stable but charged every
  cheap hour the peak price: measured at **$22.63 of pure overestimate** across the real rows behind
  one Overview (a 36% overshoot against OpenRouter's own invoice). Each bucket's `first_seen`→
  `last_seen` span is fixed once its calls are recorded, so the windows are now averaged across it —
  stable *and* unbiased. With no span to go on, the peak is kept as the conservative bound. On the
  real rows this moves the all-time cost from $144.74 to $122.33 against OpenRouter's $106.91.

- **The flex tier is now priced as the flex tier.** Pinning models to OpenRouter's `openai/flex`
  endpoint (billed at exactly half the standard rates) halved the invoice but not the monitor:
  `estimated_cost_usd` is recorded at standard rates (measured: 2.0001x and 2.0x against
  OpenRouter's own charges) and the Overview re-priced at standard catalogue rates on top — the
  two together read **4x the bill**. Every cost is now scaled by the flex multiplier the routing
  config guarantees (the panel and chip via `summary.flex.mults`, the Overview inside the
  re-price), so the `openai/gpt-6-luna` acceptance row shows $0.0009175875 where it showed 4x
  that. The discount follows the current pin — the config keeps no pin history — so pre-pin usage
  of a pinned model also reads at flex rates ($1.62 of August `gpt-5.6-luna-pro` here).

- **Long-context `overrides` are no longer read as price windows.** A `min_prompt_tokens` tier was
  painted over all 168 hours of the week at its premium rate — a second doubling on the 16 of the
  22 flex models that carry a tier. The bucket's own call sizes pick the tier now (prompt-side
  tokens per call for `min_prompt_tokens`, generated tokens for a completion band), and only
  `utc_*` windows reach the weekly schedule; with no call count to size by, the premium is kept
  as the conservative bound.

---

## Pre-1.0.0 — development

Built and iterated on 2026-09-14. Never tagged, never published.

### Added

- **Status-bar chip** reporting the focused session's token consumption, registered
  as a `data` contribution with a `toggleLabel` so the status bar's right-click
  menu can hide or show it.
- **Persistent base** — the totals are read from the profile's stored session row
  (`host.listPersistedSessions()` → `/api/profiles/sessions` → `state.db`) instead
  of a process-local counter, so a resumed session shows its real total instead of
  restarting at zero.
- **Live counting while the model works** — `message.delta` (the answer) and
  `reasoning.delta` (the model thinking) add their characters as they stream
  (≈4 characters per token), and each completed API call replaces the estimate with
  the provider's reported figure.
- **Click panel** replacing an earlier hover tooltip, with the session's cache hit
  rate at two decimals, its cost, and the token split.
- **`smoke.mjs` mount test** — stub SDK plus a real React root inside an error
  boundary, with contracts for the streamed delta, completed-call adoption, the
  context row, isolation between two simulated windows and failure containment.
- **Context window** row (`used / max · percent`) with a fill bar, above the token
  section.

### Changed

- **Costs print four decimals** in the chip and in the panel (`$2.1600`), showing the stored
  value rather than a rounded figure; the cache hit rate stays at two.

- **The status-bar figure opens the details in place**: clicking it shows the detail box as a
  popover at the figure, so the figures are reachable without opening the sidebar tab. The
  pane beside SESSIONS carries the same view for when it should stay on screen; the two are
  independent instances, so either can be closed or hidden without starving the other.

- **The status-bar figure reads `tokens · hit rate · cost`**, without the `Σ` prefix: how much,
  how well it cached, then what it cost.

- **The detail view moved into the sidebar**: it was a popover on the status-bar chip and is
  now a pane (`area: 'panes'`) docked as a tab beside SESSIONS, toggled from the zone menu or
  the command palette. The chip stays as the glance figure but is no longer a click target.
  Each view runs the panel's own instance — a pane's tab unmounts with the tab and a
  status-bar item can be hidden, so neither may depend on the other being mounted.

- **The counted quantity** — from `input + output` to Hermes' own definition,
  `input + output + cache_read + cache_write`, matching `CanonicalUsage.total_tokens`
  and `hermes insights`.
- **The panel structure** — from two groups with subtotals to three rows that
  partition the session total (`Cache hit` / `Cache miss` / `Output`) closed by the
  `Total` beneath them. The percentage column, a stacked bar and an output split
  apportioned from the transcript were each added and later removed on request.
- **Contrast and geometry** — several passes that settled on the app's own
  convention (figures in the full foreground, labels muted, the `Total` emphasised
  by weight rather than colour), cost at two decimals like the chip, and a 256px
  panel.
- **Names** — plugin folder, id, toggle label, settings name and log tag renamed
  `session-tokens` → `session-monitor`, and the folder moved from
  `desktop-plugins/session-tokens/` to the repository root.
- **Docs** — `PRIVACY.md` was merged into the `README.md`, which became the single
  document for what the plugin shows, where each figure comes from, and what the
  code can and cannot access.

### Fixed

- **Every completed-call tick threw** `ReferenceError: lastTickAt is not defined` —
  dead duration bookkeeping referencing variables nothing declared. The app's
  gateway-listener wrapper swallows handler throws, so the chip silently kept its
  streamed estimate instead of adopting real totals. Found in the running app's log,
  fixed, and covered by a test that fails with that exact error if it returns.
- **Mount painted the wrong figure** (45.4M where the session total was 92.4M) — an
  explicit `rowState` gate holds the digits until the stored row resolves.
- **Subagent text could inflate the total** — child sessions relay their streamed
  text under the child's session id; those ids are recorded and never counted.
- **An idle window could inherit a busy session's numbers** — strict per-window
  attribution (runtime id or stored id only) replaced the fused
  `host.state.focusedUsage` atom and the "accept unknown ids while busy" fallback.
- **The blank context row could persist through refreshes and tab switches** — the
  backend rejects `session.context_breakdown` for a runtime id it no longer holds in
  memory (a detached or reaped session), and the pull was fired once and forgotten, so a
  rejection left the row `—` until the next turn. The pull is now retried briefly, re-asked
  by the poll while the window is still unknown, and re-asked whenever the window's
  session changes (including a resume whose runtime id arrives after the switch).
- **The monitor described the tile you last clicked, not the chat you were in** — it keyed on the
  *focused* session, and clicking around the sidebar (tiles, projects, panes) moves focus without
  changing the conversation on screen, so the figures flipped to another session until the chat
  was clicked again. It now follows the **active chat** (`activeSessionId`, resolved to its stored
  row by `resolved_id`), with the focused ids as the fallback; the app's own context gauge reads
  the same value.
- **Opening the sidebar pane could show different figures than the chip** — each view kept its
  own accumulators (live counters, anchor, high-water mark, streamed characters) and its own
  display values, so a view that had just mounted started from an empty history: the pane
  recomputed the session's numbers without the live counts the chip had been accumulating since
  the app started, and a per-view request guard let a stale read from one view write into the
  other's figures. History, displayed values and the request guards are now per window, with one
  event subscriber and one poll; the views render the same numbers by construction.
- **A refresh could show the wrong figures** — reads are async and carried no request guard, so
  a slow read issued earlier (a refresh racing the poll, or a session switch mid-read) could land
  after a newer one and paint its row into the current view, where it stayed until the next read.
  Loads and context pulls are now tagged and applied only when they are still the newest request
  *and* still belong to the session on screen; a stale response is discarded, not displayed.
- **The context row could stay blank** — it only painted from payloads pushed during a
  turn, so a panel opened on an idle session (or right after the plugin reloaded) showed
  `—` until the next call, and refreshing could not help because the stored row carries
  no context. The row is now also pulled on demand via `session.context_breakdown`
  addressed to this window's session id (the same read the app's own Context usage panel
  makes: an estimate from the live prompt, no provider call), on panel open, on refresh
  and at turn end.
- **A wrong total could stick until a tab switch** — `session.usage` carries the agent
  *process's* cumulative counter, while the stored row accumulates across processes, so
  the row already contains most of that counter. Claiming the first tick of a plugin
  lifetime as growth inflated the chip by everything the process had written (millions of
  tokens) until the monotonic display was reset by a session switch. The first tick is now
  a baseline, and a clearly regressed counter rebases instead of freezing.
- **A manual refresh could stop the live counter** — the value the live counter is
  measured against was re-snapshotted on *every* row read, so each refresh (and each
  15-second poll) discarded the growth counted so far, and the monotonic display then
  held its previous value until new tokens re-earned the discarded amount. The anchor
  now moves only when the stored row itself advances: a turn ending is what hands the
  live tokens over to the row, and that hand-over is not counted twice.
- **The counter could freeze after a resume** — a resumed session runs under a new
  runtime id while the window may still hold the previous one, so every live tick
  was rejected until the window's own state refreshed by hand (the "it only updates
  when I switch tabs and back" report). `session.info` now teaches the chip its
  session's current runtime id, checked after the stored and runtime ids.
- **The context bar rendered empty** — `jsx(type, props, child)`; in the automatic
  runtime the third argument is the **key**, not children.
- **The README's own verification block** promised output its commands could not
  produce (an `onEvent` pattern requiring a parenthesis no real call site has, and
  two wrong counts).

---

## [Unreleased]

### Changed

- **The degraded-state note is gone.** A session with no stored row yet (a brand-new chat) used to
  show `live only — no stored row for this session` above the rows. It said nothing the figures did
  not, and it appeared on every new session. The readiness gate that note accompanied is untouched:
  the digits are still held back until a row resolves, so the note's removal cannot paint a wrong
  figure.

### Added

- **An `Overview` tab** in the sidebar: the total tokens and cost of every session in the profile — subagents included — climbing while any of them runs. Its base is the same page of session rows the focused view reads; what makes it live is a per-session delta recorded for every running session's ticks, priced at the aggregate's blended rate while in flight (marked `~`) and dropped as each row is written, so nothing counts twice. The focused view's ownership filter is untouched: another session's tick moves the Overview and never the chip.
- **The backend half**: `plugins/session-monitor/dashboard/plugin_api.py` exposes Hermes' own record
  (`session_model_usage`) read-only at `/api/plugins/session-monitor/summary` — every request, token
  and dollar over every session, split by provider, task and model, which the app side cannot read.
  Gated behind `plugins.enabled` like every user plugin; the pane prefers it and falls back to the
  page of rows when it is absent. Two hypotheses proved wrong on the way: `hermes plugins enable`
  does not accept a hand-placed folder (it tracks the installed registry), and the mount requires
  `_api_file`, which comes from the manifest rather than the entry's `api` key — both checked against
  the loader's own code before claiming they worked.
- **A `Total requests` row** in the Overview: API calls counted across sessions as they are observed.
  The session row carries only tool calls and the authoritative per-session count lives in
  `session_model_usage`, which the renderer cannot read, so this is every request reported while the
  app has been running — a historical total needs the Python half.
- **A `Daily tokens` / `Daily cost` pair** in the Overview: `Daily tokens` sits above the all-time
  totals and `Daily cost` sits below `Total tokens`, resetting at 00:00 UTC.
- **A `Monthly tokens` / `Monthly cost` pair** working exactly like Daily from the first of the month.
  Both share one period implementation — one shape, two boundaries — rather than two.
- **Period attribution that cannot read zero while you work.** The first cut seeded a period from
  the usage buckets *created* inside it, which is exact for a bucket born in the period but reports
  nothing for a long-running session: buckets are per (session, model, provider, task) and are born
  once, so a session running for days contributes to the day it started and then to nothing. The
  live check made it obvious — Daily read `0` and `$0.0000` mid-conversation. A bucket that spans a
  boundary is now apportioned by the share of its session's messages inside the period (`messages`
  is the only per-session timeline; its token column is unpopulated, so the split is by message
  count, a proxy), a bucket that ended before the period still counts zero, and a bucket born inside
  it still counts in full.
- **Cost re-pricing in the backend half.** Reported as "the monthly and total cost look lower than
  OpenRouter". They were, by about 20%: `estimated_cost_usd` is written when the call happens and
  never revised, so it keeps the rates of that moment — for this install's two biggest models the
  recorded figure was well below what the same tokens cost at the catalogue price Hermes now holds
  (`deepseek/deepseek-v4.1-flash` $22.76 recorded vs $34.81 at today's rate; `z-ai/glm-5.3-flash`
  $24.11 vs $31.20; `deepseek/deepseek-v4-flash-0731` $15.77 vs $6.90, the other way). The backend
  now values each OpenRouter bucket's tokens at OpenRouter's own catalogue entry from the local
  cache, falling back to the recorded estimate when a route is unlisted.
- **The peak rate, not the active window.** The first cut of that re-pricing read the catalogue's
  `prompt`/`completion` fields, and OpenRouter reports whichever **time-of-day window is active** as
  the base price — `deepseek/deepseek-v4.1-flash` reads `$0.30/M` at 09:00 UTC and `$0.15/M` at
  14:00 UTC, with the full schedule under `overrides`. So the figure swung 2× with the clock, and
  off-peak it landed *below* even the recorded estimate ($96.87 → $72.94 between two calls an hour
  apart), which is the "still not showing the correct amount" report. The highest rate across the
  entry (base plus every override) is used instead: stable, and an upper bound on token charges
  rather than a lower one. Measured against the same account's invoice: all-time $95.44 for the
  profile ($84.71 OpenRouter) against $91.14, month $62.43 against $63.49.
- Residual error is what a token × rate cannot express — per-search fees (`$0.01` on some models)
  and whatever share of a model's calls fell in a cheaper window than the peak used. Verified with
  `dashboard/selftest.py`: three mutations (repricing removed, apportionment removed, overrides
  ignored) each fail the suite.
- **A per-day bar chart in the Overview** (last 30 UTC days): one bar per day, scaled to the
  window's peak, today in full contrast, days with no usage kept as a 2px stub so "nothing that day"
  is visible rather than absent. Pointing anywhere in a day's column reads that day out below the graph
  (date left, tokens right — the same label/figure arrangement as the rows above) and lights the
  bar; the line shows the window's ends when idle. The hover target is the full-height column, not
  the painted bar: a quiet day is a 2px stub, and asking the pointer to land on that is asking it to
  miss (reported immediately after the first cut, which hung the handler on the bar). The pointed
  column also tints, so a stub still gives feedback. No header label and no floating tooltip: the
  first cut carried a static "Tokens per day" caption that stated the peak rather than answering
  about a bar. Day attribution reuses the Daily row's rule — a bucket spread over
  the days it was alive, weighted by its session's messages on each day — and the newest bar matches
  the Daily figure exactly (asserted in both suites).
- **The chart's days are UTC, its weights are characters.** Two corrections after the first cut read
  low against OpenRouter's activity page. (1) The split was weighted by message *counts*; it now
  weights by transcript volume — content + reasoning characters, ÷4 ≈ tokens — because one
  12,000-character tool result and three terse turns are one message each while the second costs
  orders of magnitude more. A bucket spanning two days is a fixture in `selftest.py`: volume puts
  900,000 of its 1,000,000 tokens on the expensive day, a count weighting puts 800,000 on the chatty
  one. (2) The bars were cut on Bangkok days while every provider dashboard, OpenRouter's included,
  cuts on UTC — measured on this install the same day holds `1,343,080,482` tokens on one boundary
  and `1,794,678,555` on the other, a 450-million-token swing that no amount of attribution accuracy
  could reconcile. The chart is UTC-keyed and labels its dates `UTC`, and the Daily and Monthly rows
  followed it (see "One clock" below).
- **One clock, and it is the user's.** The Daily and Monthly resets started as 00:00 Asia/Bangkok,
  were moved to 00:00 UTC while reconciling against OpenRouter, and now follow **whatever zone the
  person reading them is in** — the choice that makes "today" mean today. The desktop side detects
  the zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and sends it as `?tz=<name>&offset=<minutes>`
  on the summary request; the backend prefers `ZoneInfo(name)` so a daylight-saving change is
  followed, falls back to the offset when the runtime has no tz database, and to its own local clock
  when told nothing. The chart's dates carry the zone (`Sep 14 GMT+7`).
- The size of the boundary choice, measured on this install: 2026-09-14 holds `1,343,080,482` tokens
  cut at a Bangkok midnight, `1,794,678,555` at UTC's, and `1,803,000,000`-odd at neither once the
  buckets that span the edge are apportioned. A bucket placed between the two midnights (20:00 UTC,
  03:00 next-day Bangkok) is asserted in BOTH directions in `selftest.py` — present in the user's
  day and absent from UTC's — so a plugin hardcoded to either clock fails, and a second contract
  asserts the request actually carries the zone (mutating either one out fails the suite).
- **The Overview pane's read got 16× cheaper.** Measured on this install, the summary endpoint cost
  **~850 ms on every call** while the pane polls it every 5 seconds: each `length()` pass over the
  message table is ~200 ms and the endpoint needed four of them (lifetime totals, window days, and
  the day and month shares). The shares now come from **one** aggregate pass with `chars` computed
  once in a subquery (repeating the expression in three aggregates made SQLite evaluate it three
  times per row), the weights are cached for 20 seconds behind a two-key map, and the two helpers
  that became unused were deleted rather than left behind. Same figures, **~500 ms cold / ~30 ms
  warm**.
- **The context stamp and its display test read the same source now** (verified inconsistency): the
  stamp was written from the *adopted* stored id — the one a row read resolves and rewrites — while
  the test compared it against the app's stored-id *atom*. Any session where those two disagree, which
  is the state while the app's atoms settle after a restart, had its own window stamped with one id
  and checked against another, so the row showed nothing.
- **A pushed window is accepted when it names EITHER of the window's two ids** (the adopted id or the
  app's stored id), and the stamp records both. This is a widening for robustness, **not a verified
  fix**: the premise — that the adopted ref actually diverges from the atom in the field — could not
  be reproduced in the harness, where the adoption does not trigger, so the assertion that covers it
  passes under the old rule too. Stated plainly rather than dressed as proven: it cannot reject
  anything that was accepted before, and it accepts a case that would otherwise blank the row.
- **The context row stopped blanking for resumed sessions.** The window was stamped with the runtime
  id alone and shown only while that stamp matched the chat on screen. A resumed session runs under a
  new runtime id while its stored id stays, so a figure measured for it — pushed before the window's
  own atoms caught up, or relayed — matched nothing and the row read `—` for that session. The stamp
  now carries **both** identities and either one matching is enough; the stored id is per-session and
  stable, which is the guarantee the strict check existed for, and a payload for another session is
  still dropped on its stored id before it can paint. Both directions are asserted: the old
  runtime-only rule fails the suite with the blank row reproduced (`Context—`), and removing the
  stored-id check fails it with `a foreign session.info painted its context window`.
- **A session switch stopped doing work it never needed.** Two costs rode every switch. (1) The
  profile-wide summary was re-read on each session change — the effect that re-ran per session also
  carried the backend read — so a window with the chip, the pane and the Overview open fired **three
  summary requests per switch** (asserted: a mutant that restores it reports `3 summary read(s) rode
  the switch`), each up to ~580 ms of backend work. The read now happens **once per view mount**, and
  the Overview's own loop keeps it fresh. The first attempt removed it from the switch path *and* the
  mount path, which the harness caught: a freshly opened pane lost its totals for up to 5 s, so the
  mount read is its own effect.
- **The context window is remembered per session.** `session.context_breakdown` is the slowest request
  the pane makes — the backend estimates it from the live prompt, tools and transcript — and a switch
  blanked the Context row to wait for a fresh one. The last figure each session reported is now kept
  for the life of the app run and painted immediately on return, with the read still running behind
  it. Writing it exposed a real bug: the memo key came from a render-scoped closure, so it went stale
  and filed one session's window under another's name; it is keyed by the session's own ids, read
  from the refs that are current on every render.
- **The endpoint no longer blocks the backend.** It was declared `async def` while doing blocking
  `sqlite3` work, so it held the event loop for its whole run — and the app's own session list is
  served from that same loop. Measured: a request scheduled alongside a cold read waited **489.4 ms**
  against the read's 489.3 ms, which is why opening a *session* pane became slow exactly when this
  backend half arrived: the previous version made **no REST calls at all** on mount (verified against
  `v1.1.0`), so nothing ever queued. As a plain `def` the endpoint runs in Starlette's threadpool and
  the same concurrent request waits **2 ms**. `selftest.py` asserts the handler is not a coroutine
  function, so a future "modernise it to async" fails the suite rather than silently reintroducing
  the stall.
- **A failed read no longer flips the basis.** If the summary request hiccuped — a slow backend, a
  restart — the pane cleared its recorded totals at once and fell back to the page of rows, which is
  a *different* basis (recorded estimates versus re-priced), so the numbers jumped and jumped back
  on the next success. That is the "buggy" half of the report. Failures are now tolerated up to
  three in a row before the documented fallback applies, and a recovery is asserted to land on the
  same figures rather than compounding deltas — a mutant that restores the single-failure clear
  fails the suite.
- **The read-only handle now sees current data.** The endpoint opened `state.db` with
  `immutable=1`, which tells SQLite the file cannot change — so it skips the write-ahead log and
  serves a checkpoint-stale view. The same database reported a newest bucket of `04:23` under that
  flag and `14:38` without it, which is how the chart's last bar read zero while work was in
  progress. `mode=ro` alone still refuses writes and reads through the WAL; the immutable handle
  remains only as the fallback when a WAL's shared-memory file cannot be opened.
- **Section hairlines in the Overview**: counters (**Sessions counted**, **Total requests**), then
  the token section (**Daily**, **Monthly**, **Total tokens**), then the cost section (**Daily**,
  **Monthly**, **Total cost**), each divided by the same hairline the session panel uses.
- **A live cost estimate** — the recorded cost only moves when the session row is written (turn end)
  or re-read (the 15 s poll), so a turn in progress showed a flat figure while the tokens climbed.
  While a call is in flight the in-flight tokens are priced at the row's own blended rate
  (its cost over its tokens) and the figure is marked `~`; the marker disappears the moment the
  recorded value accounts for them. The blended rate understates an output-heavy call — cache-read
  tokens cost a fraction of generated ones and the row carries no per-bucket cost — so the estimate
  lags rather than overshoots, and every read corrects it.

## [1.1.0] — 2026-09-14

The monitor becomes a two-surface, session-accurate readout, and every figure gains a provenance
rule that can be tested.

### Added

- **The detail view lives in the sidebar**: a pane (its own zone on the right) beside the session
  list, with the status-bar figure opening the same view as a popover — two doors, one panel, each
  an independent instance so closing either cannot starve the other.
- **Subagent tokens and cost**: the sessions this one spawned, and their own subagents, summed
  transitively from the same page via `parent_session_id` and shown on a `Subagents` line
  (tokens · cost). The chip's total and cost include them.
- **The context window** in the detail view: `used / max · percent` above the token rows with a fill
  bar, from the pushed usage payloads and, when nothing has been pushed yet, from an on-demand
  `session.context_breakdown` read addressed to this window's session — so a panel opened on an
  idle session is never blank.

### Changed

- **The status-bar figure reads `tokens · hit rate · cost`**, without the `Σ` prefix.
- **Costs print four decimals** (`$2.1600`) in the chip and the panel, showing the stored value
  rather than a rounded figure; the cache hit rate stays at two.
- **One history per window**: the live counters, the anchor, the high-water mark, the streamed
  characters and the displayed values are per window rather than per view, with one event
  subscriber and one poll — a view is mounted only while it is on screen (the pane's tab unmounts
  with the tab, the status-bar item can be hidden), and per-view state gave a freshly opened view
  an empty history and figures that disagreed with the other view's.

### Fixed

- **The context figure is stamped with the session it was measured for**, and shown only while the
  stamp matches the chat on screen: it was the one value with no identity of its own, so a figure
  measured for one session could sit under another indefinitely.
- **Reads are tagged and checked before they land** (sequence and identity), so a slow read issued
  earlier — a refresh racing the poll, or a session switch mid-read — cannot paint its row into the
  current view, and the guards are shared with the state, since a read from one view writing into
  the store another view is showing is the same bug wearing a different hat.
- **The per-session reset is keyed on the whole identity** (`runtimeId|storedId`) and clears the
  previous session's figures, so a session cannot inherit another's context, high-water mark or
  subagent sum. A contract asserts that a previous session's tick and streamed text cannot move the
  current one.
- Both views agree on every figure, asserted directly (the chip and the pane must report the same
  total after a row advance).

### Known limitation

- **The readout follows the focused session.** The desktop exposes two identities — the focused
  tile and `activeSessionId` — and leading with the latter pins the context figure to one session
  for every session, reproducibly. Keying on the focused session is what the data actually follows.
  The consequence: if a build moves focus when you interact with something in the sessions strip,
  the readout follows that focus. The pane therefore lives in its own zone, deliberately not docked
  into that strip. `PREFER_ACTIVE_CHAT` at the top of the plugin switches the choice in one line if
  a future desktop reports a live main-area id.

## [1.0.0] — 2026-09-14

**First public release.** The state after the development phase above; the notes
below are the release-level summary.

### Added

- **Chip** — total tokens, cost and cache hit rate for the focused session, at the
  right end of the status bar.
- **Panel** — the context window with a fill bar, then `Cache hit` / `Cache miss` /
  `Output` (a partition of the session total, closed by `Total`), then the
  cache hit rate and the cost.
- **Restart-safe totals** — the base is the stored session row, so resuming does
  not restart the count at zero.
- **Per-session isolation** — a second window, another session, or a subagent can
  never contribute to this chip.
- **The context window follows the model** — switching models clears the stale
  limit (the row reads `—`) and triggers a fresh read, instead of leaving the
  previous model's window on screen.
- **Subagent tokens and cost** — the sessions this one spawned, and their own subagents, are
  summed from the same page via `parent_session_id` and shown on a `Subagents` line
  (tokens · cost). The chip's total and cost include them, so it reports what running
  the session actually cost rather than only its own row. No new host surface: the same
  read, the same page. Live ticks from children are still refused (they carry the child's
  session id), so the figure lands when a child writes its row.
- **SDK fallbacks** — on an older desktop build without `Button` or the icon set, the
  panel renders a plain `↻` button instead of an invalid element type.
- **Refresh button** in the panel header — re-reads the stored session row
  immediately instead of waiting for the next poll, with the row's spinner while
  the read is in flight.
- **Mount test** (`smoke.mjs`) — run before installing an edited copy; it fails on
  render and effect-time errors, which `node --check` cannot see.

### Verification

- **Static check** — the app's TypeScript over the plugin catches undeclared names
  and use-before-declaration, the two classes that shipped bugs during development.
- **Mount test** — behaviour, isolation and edge-case contracts on dedicated fixture
  windows (one per situation), each mutation-checked so it fails when the bug it
  describes is reintroduced. Accounting is covered by the case where a plugin mounts
  mid-session with a process cumulative far above the row — the total must not inflate,
  growth from the baseline must be counted, a refresh must not move it, and a row
  advance must neither double-count nor drop.
- **Edge cases covered**: a draft with no session, a failing stored-row read, a build
  without `host.listPersistedSessions`, an older SDK without `Button`/`icons`, a
  provider that bills cache writes, garbage payloads (null / missing / non-numeric /
  negative / 10¹⁵), a session switch inside one window, a resumed runtime id arriving
  late, a model switch, a context pull rejected because the gateway no longer holds
  the session (retry, then a re-pull on the session change — asserted to carry the new
  id), and failure containment for a deliberately broken copy.
- **Mutation checks** — reintroducing each of these makes the suite fail by name: an
  undefined identifier, a use-before-declaration, a removed numeric guard, dropped cache
  writes, a missing refresh button, a missing event subscription, a model switch that
  leaves the old window on screen, a removed SDK fallback, an anchor that moves on every
  read, a removed baseline, a removed pull retry, and both session-change re-pull paths.

### Security

- No network requests, no storage, no filesystem access, no credentials, and no
  conversation content: streamed text is measured with `.length` and dropped, and
  `session.history` is never called.
- The complete host surface — three state atoms, four event subscriptions, one
  session read — is documented in the README with `grep` commands a reader can run
  to confirm it.
- The chip contains its own render failures in an error boundary, so a bug inside
  it degrades the readout instead of reaching the app's root boundary.

### Notes

- Requires a Hermes Desktop build with the status-bar contribution area and
  `host.listPersistedSessions`; on an older backend the chip degrades to the live
  counters and says so rather than inventing a total.
- Install: copy the `session-monitor` folder into `~/.hermes/desktop-plugins/`
  (Windows: `%LOCALAPPDATA%\hermes\desktop-plugins\`). No build step, no backend
  changes.
- License: MIT.

[1.1.0]: https://github.com/Sikarek/hermes-session-monitor/releases/tag/v1.1.0
[1.0.0]: https://github.com/Sikarek/hermes-session-monitor/releases/tag/v1.0.0
