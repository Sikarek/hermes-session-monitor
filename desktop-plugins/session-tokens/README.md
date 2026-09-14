# Session Tokens (status bar chip)

`Σ 197,238,947 tok · $1.78 · 99.82%` — the focused session's token consumption, cost and
cache-hit rate, at the right end of the Hermes Desktop status bar. Click it for the
breakdown panel; right-click the bar to hide it.

Part of [hermes-session-monitor](../../README.md).

## Install / uninstall

```bash
cp -r desktop-plugins/session-tokens ~/.hermes/desktop-plugins/     # install (folder name == plugin id)
rm -rf ~/.hermes/desktop-plugins/session-tokens                     # uninstall
```

## Files

- `plugin.js` — the whole plugin. Plain ESM, loaded uncompiled: only `@hermes/plugin-sdk`,
  `react` and `react/jsx-runtime` resolve, and UI is built with `jsx()` calls (no JSX syntax).
- `smoke.mjs` — the pre-save check (see below).

## Panels

```
Chip    Σ <total> tok · $<cost> · <hit%>
Click   Session tokens
        Cache hit  (cache read + write)      share of session
        Cache miss (uncached input)          share of session
        Output     (everything generated, reasoning included)
        ───────────────────────────────
        Cache hit rate                       two decimals
        Cost                                 $X.XXXX
```

The three token rows partition the session total, so their shares sum to 100%.

## Data sources

| Term | Source |
|---|---|
| Base | `host.listPersistedSessions(null, {profile, limit})` → `GET /api/profiles/sessions` → `state.db` (`input + output + cache_read + cache_write`) |
| Completed calls | `session.usage` events, filtered to this window's focused session (runtime id or stored id) |
| Live text | `message.delta` + `reasoning.delta`, chars ÷ 4 until the call's real total lands |

Restart-safe: the stored row is the base, so a resumed session shows its full total instead of
starting at zero.

## Editing

**Run the mount test before saving into this folder** — the app watches it, so a bad save is live
within a second, and a throw during render/effect is caught by the app's ROOT error boundary,
which blanks the entire interface:

```bash
node desktop-plugins/session-tokens/smoke.mjs      # exit 0 = safe
```

The harness stubs `@hermes/plugin-sdk` (writing its temp module inside the Hermes checkout so bare
`react` imports resolve), mounts the chip with jsdom + a real React root inside an error boundary,
fires synthetic content chunks, asserts the panel rows and the share column, checks the popover
width contract, mounts two simulated windows to prove per-session isolation, and finally mounts a
deliberately broken copy to prove the chip contains its own failures. Override the Hermes checkout
with `HERMES_REPO=/path/to/hermes-agent`, or point it at a staged file with
`SMOKE_TARGET=/tmp/candidate.js`.

If the interface ever breaks anyway: ⌘K → **Reload window**, then grep `error-boundary:root` in
`~/.hermes/logs/desktop.log`.

### Knobs

- `POLL_MS` — idle refresh of the stored row (default 15 s).
- `CHARS_PER_TOKEN` — the streaming-text estimate (default 4; lower for code/dense text).
- `DEBUG` — set `true` for a budgeted `console.error` probe; only error-level renderer console
  lines reach `~/.hermes/logs/desktop.log`.

## Verify

- Toggle: right-click the status bar → **Session tokens**; Settings → Skills → Plugins → the
  Desktop switch.
- Data check (the same endpoint the chip reads; the token comes from the backend process env):

  ```bash
  curl -H "Authorization: Bearer $HERMES_DASHBOARD_SESSION_TOKEN" \
    "http://127.0.0.1:<port>/api/profiles/sessions?limit=5&min_messages=0&archived=exclude&order=created&profile=default"
  ```
