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
- **Mount test** — behaviour, isolation and edge-case contracts, mutation-checked
  so each one fails when the bug it describes is reintroduced. Edge cases covered:
  a draft with no session, a failing or missing stored-row read, an older SDK without
  `Button`/`icons`, a provider that bills cache writes, garbage payloads (null /
  missing / non-numeric / negative / enormous), a session switch inside one window, a
  resumed runtime id, a model switch, and failure containment for a deliberately
  broken copy.

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

[1.0.0]: https://github.com/Sikarek/hermes-session-monitor/releases/tag/v1.0.0
