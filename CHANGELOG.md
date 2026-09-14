# Changelog

## 1.00 — 2026-09-14

First public release.

- Status-bar chip showing the focused session's total tokens, cost and cache-hit rate.
- Context window above the token section (`used / max · percent`, from the live usage
  payload, with a fill bar) so the split and the window sit in one popover.
- Click panel with three rows that partition the session total: **Cache hit** (`cache_read + cache_write`), **Cache miss** (uncached input) and **Output** (everything generated, reasoning included), plus the two derived figures below a rule.
- Live counting while the model works: streamed reasoning and reply text are measured chunk by chunk, and each completed API call replaces the estimate with the provider's reported total.
- Per-session isolation by strict id attribution (focused runtime id or stored id) — a second window or subagent can never contribute to this chip.
- Restart-safe base: the totals are read from the profile's stored session row, so resuming a session does not restart the count at zero.
- Documented privacy surface with verification commands; no network requests, no storage, no conversation access.
- Mount test (`smoke.mjs`) covering panel rows, share column, popover width contract, per-session isolation and failure containment.
