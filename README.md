# hermes-session-monitor

A status-bar token monitor for the **Hermes Desktop** app: how many tokens the focused session has actually burned, what they were, and what they cost — live, per session, with nothing counted twice and nothing invented.

```
Σ 197,238,947 tok · $1.78 · 99.82%          ← the chip (bottom-right status bar)
```

Click it:

```
Session tokens                197,238,947
Cache hit                 196,470,400   99.61%     ← served from the prompt cache
Cache miss                    353,194    0.18%     ← uncached input
Output                        415,353    0.21%     ← everything the model generated
──────────────────────────────────────────────
Cache hit rate                99.82%
Cost                         $1.7832
```

## What it shows

- **Cache hit** — prompt tokens served from (or written into) the provider's cache.
- **Cache miss** — uncached input tokens.
- **Output** — every token the model generated, its reasoning included.
- **Cache hit rate** — `cache_read ÷ prompt tokens`, at two decimals. Hermes' own item rounds this to a whole percent, which flattens 99.79% to "100%".
- **Cost** — the session's recorded cost. Hermes derives it from published rates, so it is an **estimate, not a provider invoice** (see Caveats).

The three token rows are a **partition**: `cache hit + cache miss + output` equals the session total exactly, so the shares add to 100% and no row is counted in another.

The number climbs **while the model works**: streamed reasoning and reply text are counted chunk by chunk (characters ÷ 4), and each completed API call snaps the total to the provider's real figure.

## Privacy & security

The whole plugin is one file you can read: `desktop-plugins/session-tokens/plugin.js`. Its complete surface is **three state atoms, three event subscriptions and one session read** — that is all of it:

| Touches | What exactly |
|---|---|
| `host.state` | `focusedStoredSessionId`, `focusedSessionId`, `focusedSessionProfile` — which session the window is showing |
| `host.onEvent` | `session.usage`, `message.delta`, `reasoning.delta` — the app's own event stream, filtered to that session |
| `host.listPersistedSessions()` | the focused profile's session rows (the numbers it displays), every 15 s and at turn end |
| `host.notify` | not used |

**It does not:**

- **read your conversation.** Streamed text passes through the handler only to be *measured* — `.length` is taken and the text is dropped. No message content, no prompts, no tool results are read, stored or shown. (There is no transcript read at all: `session.history` is not called.)
- **make network requests.** No `fetch`, no `WebSocket`, no third-party endpoints, no telemetry. Every read goes through the app's own local backend.
- **write anything.** No files, no `localStorage`, no `ctx.storage`, no config keys, no credentials. Uninstalling leaves nothing behind.
- **touch secrets.** It never reads `.env`, API keys or tokens. The cost it displays is the number Hermes already stored in your session row.

Verify it yourself:

```bash
grep -nE "fetch\(|XMLHttpRequest|WebSocket|localStorage|ctx\.storage|process\.|require\(" plugin.js   # no hits
grep -o "host\.[a-zA-Z]*" plugin.js | sort | uniq -c                                                  # the 4 calls above
```

**Risk that is inherent to the platform, not this plugin:** a Hermes desktop plugin is evaluated with the app's privileges — it is not a sandbox. That is why the code is short, unminified, and documented here: read it before installing, as you would any plugin. This one sends nothing anywhere, so there is nothing to leak even in principle.

## Compatibility

- **macOS, Linux, Windows** — the plugin is plain ESM using only the plugin SDK, React and standard web APIs (`setInterval`, `requestAnimationFrame`). No Node APIs, no shell commands, no OS-specific paths or calls.
- **Hermes Desktop** — any build with the status-bar contribution area and `host.listPersistedSessions`. On an older backend that lacks the session read, the chip degrades to the live counters and says `live only — no stored row for this session` instead of inventing a total.
- The app-level plugin root is resolved per machine, so it also works when the window is pointed at a **remote or cloud** gateway (the plugin still loads locally).

## Install

```bash
git clone https://github.com/Sikarek/hermes-session-monitor.git
mkdir -p ~/.hermes/desktop-plugins
cp -r hermes-session-monitor/desktop-plugins/session-tokens ~/.hermes/desktop-plugins/
```

Windows: copy the folder to `%LOCALAPPDATA%\hermes\desktop-plugins\session-tokens\`.

The app watches that folder — the chip appears within a second. If it doesn't, press ⌘K → **Reload desktop plugins**.

**Uninstall:** `rm -rf ~/.hermes/desktop-plugins/session-tokens` — nothing else is touched (no config keys, no backend, no restart).

## Where it appears / how to toggle

- **Chip** — right end of the status bar.
- **Click** — the detail panel above.
- **Hide/show** — right-click the status bar → **Session tokens**.
- **Disable entirely** — Settings → Skills → Plugins → the *Session Tokens* row, Desktop switch.

## How it works

| Term | Source | Survives a restart |
|---|---|---|
| Base total | `host.listPersistedSessions()` → `GET /api/profiles/sessions` → the profile's `state.db` | yes — it's the stored session row |
| Completed calls | `session.usage` events, **strictly attributed** to this window's focused session | no (process-local), but only ever added on top of the base |
| Live text | `message.delta` (answer) + `reasoning.delta` (thinking), counted as they stream | no — zeroed by the next completed call |

- **The base is Hermes' own definition**: `input + output + cache_read + cache_write` — the same "Total tokens" as `agent/insights.py` and the units of `session_total_tokens`. Reasoning is a *detail inside* `output`, never added.
- **Per-session isolation**: every term is attributed by session id (the focused session's runtime id or its stored id) — no guessing, no "accept anything while busy". A `session.usage` event from another session can never land in your chip.
- **Restart-safe**: the agent's counters are process-local and restart at zero, which is why a live-only counter appears to reset; the stored row does not.
- **Subagents are excluded on purpose** — their tokens live in their own session rows and the parent row doesn't include them, which matches what `/usage` reports.

## Development

The plugin is a single plain-ESM file — loaded uncompiled, no build step, hot-reloaded on save.

**Before saving into a watched folder, run the mount test:**

```bash
node desktop-plugins/session-tokens/smoke.mjs
```

It stubs the plugin SDK, mounts the chip against a real React root inside an error boundary, fires synthetic content chunks, asserts the panel rows and the share column, checks the popover width contract, mounts two simulated windows to prove per-session isolation, and finally mounts a deliberately broken copy to prove the chip contains its own failures. It fails on render *and* effect-time errors — `node --check` cannot see an undefined identifier, and a plugin throw reaches the app's ROOT error boundary (which blanks the whole window).

## Caveats

- **Cost is an estimate.** Hermes prices from published rates (`official_docs_snapshot` for Anthropic/OpenAI, `provider_models_api` for OpenRouter/DeepSeek); the provider's invoice can differ. OpenRouter exposes a real per-generation charge, but not through anything a plugin can read.
- **One rate for reasoning.** Hermes prices reasoning at the model's output rate; a few models publish a *different* reasoning rate, where this estimate would be off.
- **Main task only.** Hermes' session row excludes auxiliary work attributed to the same session (background review, title generation) — that lives in `session_model_usage` and is not reachable from the app side.
- **Cache hit includes cache writes.** A write is a miss being cached, priced above plain input; it becomes a hit on the next call. It's 0 on routes without explicit caching (DeepSeek/OpenRouter today), so on Anthropic this number includes a chunk that wasn't strictly a hit.
- **Per-word counting is an estimate.** Streamed text is measured at ~4 characters per token until the call's real total arrives.

## License

MIT — see [LICENSE](LICENSE).
