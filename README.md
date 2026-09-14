# hermes-session-monitor

**v1.0.0** · MIT · macOS · Linux · Windows · [Changelog](CHANGELOG.md)

A live token, context-window, cost and cache-hit monitor for the **Hermes Desktop** status bar. It reports how many tokens the focused session has actually processed, how they break down, how full its context window is, and what they cost — per session, restart-safe, with every figure traceable to a source.

```
Σ 197,238,947 tok · $1.78 · 99.82%            the chip, at the right end of the status bar
```

Click the chip for the breakdown:

```
Session monitor                            ↻      refresh (re-reads the stored row)
Context             421,888 / 1,000,000 · 42%     the window in use
█████████████████░░░░░░░░░░░░░░░░░░░░░░░          fill bar = share of the window
Cache hit                 196,470,400     prompt tokens served from the provider cache
Cache miss                    353,194     uncached input
Output                        415,353     everything the model generated
Total                     197,238,947     the three rows above, added up
──────────────────────────────────────────────
Cache hit rate                99.82%
Cost                             $1.78
```

## What it shows

| Row                      | Meaning                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Context**         | Tokens currently in the window / the model's window, and the share in use, above a fill bar. Read from the same live usage payloads as the totals. |
| **Cache hit**      | Prompt tokens served from — or written into — the provider's cache (`cache_read + cache_write`).                                           |
| **Cache miss**     | Uncached input tokens.                                                                                                                         |
| **Output**         | Every token the model generated, reasoning included.                                                                                           |
| **Cache hit rate** | `cache_read ÷ prompt tokens`, to two decimals. Hermes' own status-bar item rounds this to a whole percent, which flattens 99.79% to "100%". |
| **Cost**           | The cost Hermes recorded for this session — see [Cost](#cost) for how it is derived and how accurate it is.                                     |

The three token rows **partition** the session total: `cache hit + cache miss + output` equals the **Total** row shown beneath them exactly, so no token is counted in two rows. The rows carry no percentages — the Total beneath them states the partition, and the cache ratio is the **Cache hit rate** figure below the rule.

The number moves **while the model works**: streamed reasoning and reply text are counted chunk by chunk as they arrive, and each completed API call snaps the total to the provider's reported figure.

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

| Action           | Where                                                                |
| ---------------- | -------------------------------------------------------------------- |
| Chip             | Right end of the status bar                                          |
| Detail panel     | Click the chip                                                       |
| Refresh          | **↻** at the top right of the panel — re-reads the stored session row now instead of waiting for the next poll |
| Hide / show      | Right-click the status bar → **Session monitor**              |
| Disable entirely | Settings → Skills → Plugins → *Session Monitor* → Desktop switch |

## How it works

The total is assembled from three sources, in this order:

| Term            | Source                                                                                                       | Survives a restart                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Base total      | `host.listPersistedSessions()` → `GET /api/profiles/sessions` → the profile's `state.db` session row | Yes — it is the stored row                                |
| Completed calls | `session.usage` events, attributed strictly to this window's focused session                               | No (process-local), but only ever added on top of the base |
| Live text       | `message.delta` (answer) and `reasoning.delta` (thinking), counted as they stream                        | No — superseded by the next completed call                |

- **The base uses Hermes' own definition** — `input + output + cache_read + cache_write`, the same "Total tokens" as `agent/insights.py`. Reasoning is a detail *inside* `output` and is never added separately.
- **Per-session isolation** — every term is attributed by session id (the focused session's runtime id or its stored id). There is no fallback that accepts unknown ids, so another session's events can never enter this chip.
- **Restart-safe** — the agent's live counters are process-local and restart at zero, which is why a live-only counter appears to reset; the stored row does not.
- **Subagents are excluded by design** — their tokens live in their own session rows, which the parent row does not include. This matches what `/usage` reports.
- **The Context row is live, not stored** — it comes from `context_used` / `context_max` / `context_percent` on those same two event payloads, so it shows `—` until the first one arrives and a `~` when the backend marks the figure as estimated. The window follows the model: switching models clears it (the row reads `—` rather than the previous model's limit) and triggers a fresh read.
- **Reads never disturb the live term** — the anchor the live counter is measured against only advances when the *stored row* does, i.e. when a turn ends and is written. Reading the row (the 15-second poll, or the refresh button) therefore leaves the growth already counted in place; refreshing mid-turn cannot stall the counter.
- **Resumed sessions re-attach on their own** — a resumed session runs under a new runtime id; its own `session.info` (which carries the stored id, so it is proof rather than a guess) teaches the chip that id, and the live ticks are attributed again. Without that step the counter would freeze until the window's own state refreshed.

## Cost

Cost is **read from the session row, not recomputed**: Hermes prices each call as

```
input × in_rate + output × out_rate + cache_read × read_rate + cache_write × write_rate   (per 1M tokens)
```

and the result is stored per session. Rates come from Hermes' price map — `official_docs_snapshot` for Anthropic and OpenAI, `provider_models_api` (models.dev, cached) for OpenRouter and DeepSeek — with per-request prices and context tiers where a provider publishes them.

**Accuracy.** Three consequences follow from that design:

- The value is an **estimate from published rates**, not the provider's invoice — they can differ.
- Reasoning tokens are priced at the model's **output rate**. On the few models that publish a different reasoning rate, the estimate is off by the difference.
- OpenRouter reports a real per-generation charge, but not through any data a plugin can read, so it is not used.

## Privacy & security

The plugin displays numbers the app already has. It makes **no network requests of its own, writes nothing, and never reads your conversation.** The complete surface — four state atoms, four event subscriptions and one session read — is listed below and can be verified line by line: the source ships unminified.

| Host call                             | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `host.state.focusedStoredSessionId` | Which session this window is showing                        |
| `host.state.focusedSessionId`       | Its runtime id                                              |
| `host.state.focusedSessionProfile`  | Its profile                                                 |
| `host.state.model`                  | The model in use — the context window belongs to it          |
| `host.onEvent('session.usage')`     | Completed-call token totals and the context window          |
| `host.onEvent('session.info')`      | The same usage snapshot when a session is opened or resumed |
| `host.onEvent('message.delta')`     | The answer's streamed text (measured, not kept)             |
| `host.onEvent('reasoning.delta')`   | The reasoning's streamed text (measured, not kept)          |
| `host.listPersistedSessions()`      | The focused profile's session rows — the figures displayed |

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
grep -oE "host\.(onEvent\('[a-z.]+'|state\.[a-zA-Z]+|listPersistedSessions)" plugin.js | sort | uniq -c
#    → 3 host.listPersistedSessions          (1 call + 2 comment mentions)
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

**Failures are contained.** The chip wraps its own render in an error boundary, so a bug inside it degrades to `Σ — tok` instead of reaching the app's root boundary.

## Compatibility

- **macOS, Linux, Windows** — plain ESM using only the plugin SDK, React and standard web APIs (`setInterval`, `requestAnimationFrame`, `Intl` number formatting). No Node APIs, no shell commands, no OS-specific paths or calls; the plugin file is identical on every platform, only the install path differs.
- **Hermes Desktop** — any build providing the status-bar contribution area and `host.listPersistedSessions`. On an older backend without the session read, the chip degrades to the live counters and reports `live only — no stored row for this session` rather than inventing a total.
- **Remote gateways** — the plugin root is resolved locally, so the chip still loads when the window is connected to a remote or cloud gateway.

## Known limitations

- **Main task only.** The session row does not include auxiliary work attributed to the same session (background review, title generation); that data lives in `session_model_usage` and is not reachable from the app side, so it is not shown.
- **Cache hit includes cache writes.** A write is a miss being cached — priced above plain input, counted as a hit on the next call. It is 0 on routes without explicit caching (DeepSeek, OpenRouter), so on Anthropic this row includes a portion that was not strictly a hit.
- **Live text is an estimate.** Streamed text is counted at ≈4 characters per token until the call's real total arrives, after which the estimate is replaced.
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

# 2. behavioural
node session-monitor/smoke.mjs
```

### What the mount test covers

It stubs the SDK, mounts the chip against a real React root inside an error
boundary, and fails on render *and* effect-time errors (`node --check` cannot see
an undefined identifier, and an uncontained throw reaches the app's root boundary,
which blanks the window).

Behaviour — a streamed chunk moves the total by exactly `chars ÷ 4`; a completed
call is adopted; the context row paints from an attributed payload and its bar
matches the reported percent; the refresh button performs a fresh read; the
labels/figures contrast rule and the percentage-free rows hold; the popover width
contract holds.

Isolation — two simulated windows keep separate totals; a foreign session's tick,
context payload or text is refused; a tick from a resumed runtime id IS adopted
(its own `session.info` taught the chip that id).

Edge cases — each is a situation the chip meets in the field:

| Situation | What must happen |
|---|---|
| A draft with no session yet (`null` ids) | Renders, reports that no stored row exists |
| The stored-row read throws (backend hiccup) | Live counting keeps working |
| An older build without `host.listPersistedSessions` | Mounts and degrades, never throws |
| An older SDK without `Button` or the icon set | Still renders a working refresh control (plain button + `↻`) |
| A provider that bills cache writes | `Cache hit` = read + write, and the total includes both |
| A garbage payload (`null`, missing fields, non-numeric, negative, 10^15) | Nothing invalid is painted — no `NaN`, no `undefined` |
| A session switch inside one window | The new session takes over; the abandoned one stops counting |
| A model switch | The context window clears and a fresh read is triggered |
| A manual refresh (or the 15 s poll) while the model works | The live term survives; the counter keeps climbing, and a row advance is not counted twice |
| A deliberately broken copy of the plugin | The error boundary contains it; the app root is never reached |

Every assertion above was mutation-checked: reintroducing each bug makes the suite
fail with a message naming it (verified for the undefined identifier, the
use-before-declaration, a removed numeric guard, dropped cache writes, the missing
refresh button, a missing event subscription, and a model switch that leaves the
old window on screen).

## License

MIT — see [LICENSE](LICENSE).



## Why this exists

This is my first public repository. I built it because I wanted to see my real-time token usage, and I figured other people might find it useful too. :)
