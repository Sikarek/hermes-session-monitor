# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 entries are **development milestones** from the first day of work: they
describe what each stage changed, and none of them was tagged or published.
The git history is the authoritative record; these entries group it.

## [1.0.0] — 2026-09-14

First public release.

### Added

- **Status-bar chip** showing the focused session's total tokens, cost and cache
  hit rate, with a hide/show toggle in the status bar's own right-click menu and
  a switch in Settings → Skills → Plugins.
- **Click panel** modelled on the built-in Context usage popover: the context
  window (`used / max · percent`) with a fill bar, three rows that partition the
  session total — **Cache hit** (cache read + write), **Cache miss** (uncached
  input), **Output** (everything generated, reasoning included) — closed by the
  **Total** they sum to, then a hairline and the two derived figures
  (**Cache hit rate** at two decimals, **Cost**).
- **Live counting**: streamed reasoning and reply text are counted chunk by
  chunk while the model works, and each completed API call replaces the estimate
  with the provider's reported figure.
- **Restart-safe totals**: the base is the profile's stored session row, so a
  resumed session shows its real total instead of restarting at zero.
- **Per-session isolation**: every term is attributed strictly by session id
  (the focused session's runtime id or its stored id); no fallback accepts
  unknown ids, so a second window or a subagent can never contribute.
- **Mount test** (`smoke.mjs`): a stub-SDK harness that mounts the chip inside an
  error boundary and asserts the behaviour contracts — streamed chunks move the
  total by exactly `chars ÷ 4`, a matching `session.usage` tick is adopted, the
  context row paints from `session.info` and its bar width matches the reported
  percent, a foreign session tick or context payload is rejected, the rows carry
  no percentages, the labels/figures contrast rule holds, the popover width
  contract holds, two simulated windows stay isolated, and a deliberately broken
  copy proves failure containment.
- Documentation: README (what it shows, how it works, cost methodology, privacy
  surface with verification commands, compatibility, known limitations) and
  CHANGELOG.

### Changed

- Plugin renamed from `session-tokens` to **`session-monitor`**; the plugin
  folder moved from `desktop-plugins/session-tokens/` to the repository root as
  `session-monitor/`, so installing is a single `cp`.
- Panel width narrowed to 256px after the percentage column was removed.
- Cost is printed at two decimals in the panel, matching the chip.
- The panel's contrast follows the app's own panels: figures in the full
  foreground, labels muted, the Total carrying the emphasis by weight.

### Fixed

- **A completed-call tick threw `ReferenceError`** (`lastTickAt`/`rate`, declared
  nowhere after an earlier edit) — the app's gateway-listener wrapper swallows
  handler throws, so the chip silently kept its streamed estimate instead of
  adopting real totals. Fixed, and the suite now fails on that exact error.
- Chip painted a live-only figure on mount (45.4M instead of 92.4M) — an explicit
  `rowState` gate holds the digits until the stored row lands.
- Subagent child text could inflate the total — child session ids are excluded.
- An idle window could inherit a busy session's numbers — strict per-window
  attribution replaced the fused `host.state.focusedUsage` atom and the
  "accept unknown ids while busy" fallback.
- `jsx(type, props, child)` was used for the context bar — in the automatic
  runtime the third argument is the **key**, so the element rendered empty.
- The README's own verification block promised output its commands could not
  produce (an `onEvent` pattern that required a closing parenthesis a real call
  site does not have, and two wrong counts).

### Security

- No network requests, no storage, no filesystem access, no credentials, and no
  conversation content: streamed text is measured with `.length` and dropped, and
  `session.history` is never called. The complete host surface — three state
  atoms, four event subscriptions, one session read — is documented with `grep`
  commands a reader can run to confirm it.
- The chip contains its own render failures in an error boundary, so a bug inside
  it degrades the readout instead of reaching the app's root boundary.

## [0.9.0] — 2026-09-14

### Added

- **Context window** above the token section: `used / max · percent` from the
  live usage payloads, with a fill bar whose width is the share in use. Painted
  by `session.info` (stored id) as well as `session.usage` (runtime id), so it
  appears before the next API call.

## [0.8.0] — 2026-09-14

### Changed

- **Contrast and layout passes**: figures in the full foreground with muted
  labels (the app's own convention), the Total emphasised by weight, the row
  percentages removed — the Total states the partition — and the panel narrowed
  to 256px. Each rule is asserted by the smoke test, including a regression guard
  that no panel row contains a percentage.

## [0.7.0] — 2026-09-14

### Changed

- **Panel restructured** into three rows that partition the session total —
  `Cache hit` / `Cache miss` / `Output` — with the Total moved beneath them and
  one denominator for every share (removed again in 0.8.0).
- **Renamed** the plugin folder, id, toggle label, settings name and log tag to
  `session-monitor`, and the repository file `PRIVACY.md` was merged into the
  README, which became the single document for what the plugin shows, how it is
  sourced and what it can access.

## [0.6.0] — 2026-09-14

### Added

- **Click panel** replacing the hover tooltip: cache hit rate at two decimals
  (Hermes' own item rounds to a whole percent, which flattens 99.79% to "100%"),
  the session cost, and — briefly — an output split (reply text / reasoning /
  tool-call arguments) apportioned from the transcript, removed again in 0.7.0.

## [0.5.0] — 2026-09-14

### Fixed

- **Per-session isolation**: strict ownership — an event counts only if it carries
  this window's focused session's runtime id or stored id. The fused
  `host.state.focusedUsage` atom was dropped (the app merges rather than replaces
  that store, so an idle window could inherit a busy session's numbers), and the
  runtime session is re-anchored on resume.
- Two-window isolation became a permanent test.

## [0.4.0] — 2026-09-14

### Fixed

- **Mount gate**: the chip no longer paints the process-local live counter before
  the stored row resolves (it showed 45.4M where the session total was 92.4M).
- **Subagent text excluded**: child sessions relay their streamed text under the
  child's id; those ids are recorded and never counted.
- Accounting verified end to end: `input + output + cache_read + cache_write`
  matched the backend's session row and `hermes insights`, and individual tick
  jumps matched individual API calls.

## [0.3.0] — 2026-09-14

### Added

- **Live, word-by-word counting**: `message.delta` (the answer) and
  `reasoning.delta` (the model thinking) add their characters as they arrive,
  converted at ~4 characters per token. `thinking.delta` is deliberately excluded
  — it carries short status strings ("✻ Thinking…"), measured 344 chunks of which
  none moved the counter while the model actually thought.
- No smoothing, no interpolation, no tween: the number repaints on the next
  animation frame after each chunk, and the next completed call zeroes the
  streamed estimate.

## [0.2.0] — 2026-09-14

### Fixed

- **The counted quantity**: input + output only (282,540) became all four buckets
  — `input + output + cache_read + cache_write` — matching Hermes'
  `CanonicalUsage.total_tokens` (26.7M at the time of the fix).
- **The frozen counter**: events carry different session ids per emitter;
  an alias set learned from `session.info` fixed it (superseded by strict
  ownership in 0.5.0).
- **Restart safety**: the module-level last-shown value plus a priming snap stop
  the chip from restarting at zero on every reload, and an explicit placeholder
  (`Σ … tok`) replaces any invented figure.

## [0.1.0] — 2026-09-14

### Added

- Initial plugin: a status-bar chip showing the focused session's token
  consumption, with the persisted base read from the profile's session row and a
  live delta from `session.usage` events — the fix for the built-in counters that
  reset to zero on restart.
- Registered as a `data` contribution with a `toggleLabel`, so the status bar's
  right-click menu lists it under **Show in status bar**.

[1.0.0]: https://github.com/Sikarek/hermes-session-monitor/releases/tag/v1.0.0
