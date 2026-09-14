# Privacy & security

Short version: **this plugin has no way to collect, transmit, or store your data.** It renders numbers the app already has. Everything below is checkable in `plugin.js` — one plain-JS file, no build step, no minification, 532 lines.

## The complete surface

A disk-loaded plugin may import only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` — this one imports nothing else. Its entire host API surface:

| Call | What it is | Reads |
|---|---|---|
| `host.state.focusedStoredSessionId` | the focused session's durable id | an atom |
| `host.state.focusedSessionId` | its runtime id | an atom |
| `host.state.focusedSessionProfile` | its profile name | an atom |
| `host.onEvent('session.usage')` | completed-call token totals | an event |
| `host.onEvent('message.delta')` | the answer's streamed text | an event |
| `host.onEvent('reasoning.delta')` | the reasoning's streamed text | an event |
| `host.listPersistedSessions(null, {profile, limit})` | the focused profile's session rows (the numbers displayed) | tokens, cost, message count |

Three atoms, three event subscriptions, one read. That is the whole list.

## What it does NOT do

- **No network egress.** It cannot talk to any server — not the model provider, not OpenRouter, not a telemetry endpoint. The only data path is the local Hermes backend the app itself is connected to.
- **No data collection or telemetry.** Nothing is sent anywhere: no analytics, no identifier, no ping.
- **No storage.** It writes nothing to disk and nothing to browser storage; it has no settings to persist.
- **No credentials.** It never reads `.env`, config files, API keys or tokens.
- **No transcript access.** Streamed text passes through the handler only to be *measured* — `text.length` is added to a counter and the text is dropped. No prompt, message body, or tool result is read, kept or shown. `session.history` is not called at all.
- **No subagent data.** Child sessions have their own rows, and their relayed text carries the child's session id — which the plugin's strict id filter excludes by construction. `smoke.mjs` covers this.

## Verify it yourself

```bash
cd desktop-plugins/session-tokens

# 1) no network, storage, filesystem or process access anywhere in the file
grep -nE "fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|ctx\.storage|process\.|require\(" plugin.js
#    → no output

# 2) every host call site, with its count
grep -oE "host\.(onEvent\('[a-z.]+'\)|state\.[a-zA-Z]+|listPersistedSessions)" plugin.js | sort | uniq -c
#    → 1 host.listPersistedSessions
#    → 1 host.onEvent('message.delta'   · 1 reasoning.delta · 1 session.usage
#    → 1 host.state.focusedSessionId    · 1 focusedSessionProfile · 1 focusedStoredSessionId
#    (two `focusedUsage` mentions also match — both are comments saying that atom
#     is deliberately NOT used, so another session's numbers cannot bleed in)

# 3) no transcript or message-content access
grep -cE "session\.history|\.content\b" plugin.js
#    → 0

# 4) streamed text is measured, never kept
grep -n "text.length" plugin.js
#    → chars.current += text.length
```

## The honest caveat about plugins in general

A Hermes desktop plugin is **not** sandboxed: it runs inside the app with the app's privileges, so a plugin *could* do any of the things above if it were written to. The host restricts which modules it may import, not what it may then call. That is exactly why this code is published uncompiled and unminified — **you don't have to trust this document, you can read the file.**

## Failures are contained, not silent

The chip wraps itself in its own error boundary, so a bug inside it can at worst make the chip read `Σ — tok` — it cannot take the app's interface down. `smoke.mjs` proves it by mounting a deliberately broken copy and asserting the app's ROOT boundary is never reached.

## Platform support

macOS, Windows and Linux — the platforms Hermes Desktop runs on. No platform-specific paths, binaries, shell commands or Node APIs: only the SDK, React, and standard browser APIs (`setInterval`, `requestAnimationFrame`, `Intl` number formatting). The plugin file itself is identical on every OS; the install path differs and the README covers the Windows one.

`smoke.mjs` (a development-only file, never loaded by the app) locates the Hermes checkout through `os.homedir()` and creates its temp module inside that checkout, so it works on all three platforms without hardcoded paths.
