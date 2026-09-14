# Changelog

Chronological record of this plugin: everything the development phase added and
changed (**Pre-1.0.0**), then the first public release (**1.0.0**).

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html); the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
