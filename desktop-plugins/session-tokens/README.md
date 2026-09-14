# Session Tokens — plugin maintenance notes

The status-bar chip itself. What it shows, how the numbers are sourced and its privacy surface are documented once, in the [root README](../../README.md); this file covers only working on the plugin.

## Files

- `plugin.js` — the whole plugin. Plain ESM, loaded uncompiled: only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve, and the UI is built with `jsx()` calls (no JSX syntax).
- `smoke.mjs` — the pre-save mount test.

## Install / uninstall

```bash
cp -r desktop-plugins/session-tokens ~/.hermes/desktop-plugins/   # install — folder name must equal the plugin id
rm -rf ~/.hermes/desktop-plugins/session-tokens                   # uninstall — removes everything
```

## Editing

The app watches this folder, so a bad save is live within a second, and an uncontained throw during render or effect reaches the app's **root** error boundary, which blanks the entire interface. Test before saving:

```bash
node desktop-plugins/session-tokens/smoke.mjs          # exit 0 = safe to install
HERMES_REPO=/path/to/hermes-agent node …/smoke.mjs      # if the checkout is elsewhere
SMOKE_TARGET=/tmp/candidate.js node …/smoke.mjs         # test a staged file instead
```

The harness stubs the plugin SDK, mounts the chip against a real React root inside an error boundary, fires synthetic content chunks, asserts the panel rows and share column, checks the popover width contract, mounts two simulated windows to prove per-session isolation, and mounts a deliberately broken copy to prove failure containment.

If the interface breaks anyway: ⌘K → **Reload window**, then grep `error-boundary:root` in `~/.hermes/logs/desktop.log`.

### Knobs

| Constant | Default | Effect |
|---|---|---|
| `POLL_MS` | 15 s | Idle refresh interval for the stored session row |
| `CHARS_PER_TOKEN` | 4 | Streaming-text estimate; lower it for code-heavy or dense text |
| `DEBUG` | `false` | Set `true` for a budgeted `console.error` probe; only error-level renderer console lines reach `~/.hermes/logs/desktop.log` |

## Manual verification

```bash
# toggle: right-click the status bar → Session tokens; Settings → Skills → Plugins → Desktop switch

# cross-check the chip against the endpoint it reads (the bearer token comes from
# the backend process env; the port is the one the gateway is listening on)
curl -H "Authorization: Bearer $HERMES_DASHBOARD_SESSION_TOKEN" \
  "http://127.0.0.1:<port>/api/profiles/sessions?limit=5&min_messages=0&archived=exclude&order=created&profile=default"
```
