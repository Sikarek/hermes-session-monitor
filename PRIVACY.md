# Privacy & security

Short version: **this plugin has no way to collect, transmit, or store your data.** It renders numbers the app already has. Everything below is checkable in `plugin.js` — it is one plain-JS file, no build step, no minification, ~560 lines.

## What it touches — the complete list

The plugin imports exactly three things: `react`, `react/jsx-runtime`, and `@hermes/plugin-sdk` (a disk-loaded plugin is restricted to those three specifiers by the host).

Its entire host API surface:

| Call | What it does | Reads |
|---|---|---|
| `host.state.focusedStoredSessionId` | the focused session's durable id | an atom |
| `host.state.focusedSessionId` | its runtime id | an atom |
| `host.state.focusedSessionProfile` | its profile name | an atom |
| `host.state.busy` | is the focused chat working | an atom |
| `host.onEvent('session.usage' \| 'message.delta' \| 'reasoning.delta' \| 'session.info' \| subagent.*)` | subscribes to the local gateway event stream | — |
| `host.listPersistedSessions(null, {profile, limit})` | asks the app for the focused session's stored row | tokens, cost, message_count |

That is the whole list. There is **no** `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `fs`, `process.env`, `child_process`, or `require` anywhere in the file (grep it yourself — each of those words appears zero times outside comments).

## What it does NOT do

- **No network egress.** It cannot talk to any server — not the model provider, not OpenRouter, not a telemetry endpoint. The only data path is the local Hermes backend the app itself is connected to.
- **No data collection or telemetry.** Nothing is sent anywhere, ever. There is no analytics, no identifier, no ping.
- **No storage.** It writes nothing to disk and nothing to your browser storage. It has no settings to persist.
- **No credentials.** It never reads `.env`, config files, API keys, or tokens.
- **No transcript access.** An earlier development build read the transcript (`session.history`) to split output into prose vs tool calls; that was removed, so the shipped plugin never sees your conversation text — it sees only token *counts*.
- **No subagent data.** Child sessions are explicitly excluded from the count (verified by the test in `smoke.mjs`).

## The honest caveat about plugins in general

A Hermes desktop plugin is **not** sandboxed. It runs inside the app with the app's privileges, so a plugin *could* do any of the above if it were written to — the host only restricts which modules it may import, not what it may then call. That is exactly why the code is published uncompiled and unminified: **you don't have to trust this README, you can read the file.** Nothing is hidden and there is nothing to hide.

Practical review checklist, if you'd rather verify than believe:

```bash
grep -nwE "fetch|XMLHttpRequest|WebSocket|localStorage|require" plugin.js   # expect: no output
grep -nE "^import" plugin.js                                               # expect: 4 import lines, only react + the SDK
grep -n "host\." plugin.js | wc -l                                         # 16 call sites, all in the table above
```

## Failures are contained, not silent

The chip wraps itself in its own error boundary, so a bug inside it can only ever make the chip read `Σ — tok` — it cannot take your app's interface down. `smoke.mjs` proves this by mounting a deliberately broken copy of the plugin and asserting the app's root boundary is never reached.

## Platform support

macOS, Windows, and Linux — the exact platforms Hermes Desktop runs on. The plugin uses no platform-specific paths, binaries, shell commands, or Node APIs: only the SDK and standard browser APIs (`requestAnimationFrame`, `setInterval`, `Intl` number formatting). The install instructions in the README cover the Windows plugin path as well. `smoke.mjs` (the test) locates the Hermes checkout with `os.homedir()` and creates its temp directory inside it, never from a hardcoded `/tmp` path.
