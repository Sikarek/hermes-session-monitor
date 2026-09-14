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

- **Cache hit** — prompt tokens served from the provider's cache (reads + writes).
- **Cache miss** — uncached input tokens.
- **Output** — every token the model generated (that includes its reasoning).
- **Cache hit rate** — `cache_read ÷ prompt tokens`, at two decimals. Hermes' own item rounds this to a whole percent, which flattens 99.79% to "100%".
- **Cost** — the session's recorded cost. Hermes derives it from published rates, so it is an **estimate, not a provider invoice** (see Caveats).

The three token rows are a **partition**: `cache hit + cache miss + output` equals the session total exactly, so the shares add to 100% and no row is counted in another.

The number climbs **while the model works**: streamed reasoning and reply text are counted chunk by chunk, and each completed API call snaps the total to the provider's real figure.

## How it tracks tokens

Three terms, one definition, nothing counted twice:

| Term | Where it comes from |
|---|---|
| **Base** | the session's row in Hermes' own `state.db` (`input + output + cache_read + cache_write`) — read through the app, never parsed by hand |
| **Completed calls** | `session.usage` events from the local gateway, **attributed strictly** to the focused session (its runtime id or stored id) |
| **Live text** | `message.delta` (the answer) and `reasoning.delta` (the thinking), counted as they stream, ÷4 chars per token |

The base makes it restart-safe — that row survives app restarts, while the agent's in-process counters reset to zero (which is why a live-only counter looks like it resets). The live terms are added on top and are zeroed when a completed call reports the real figure, so a call is counted once. `reasoning` is never added separately: the provider counts it *inside* `output` (adding it would overstate by ~56% on a reasoning-heavy session).

## How it tracks cost

It reads the **cost Hermes already recorded for the session** (`estimated_cost_usd` on the same row) — it does not compute pricing itself. Hermes derives that number from published model rates: `official_docs_snapshot` for Anthropic/OpenAI, `provider_models_api` (models.dev) for OpenRouter/DeepSeek and friends.

So: **it is an estimate, not a provider invoice.** Hermes prices reasoning at the model's output rate (a few models publish a different reasoning rate, where the estimate would be off), and the figure covers the session's **main task only** — auxiliary work attributed to the same session (background review, title generation) is tracked separately by Hermes and isn't reachable from the app side. OpenRouter does expose a real per-generation charge, but nothing a desktop plugin can reach today.

## Privacy & security

No network calls, no telemetry, no storage, no credentials, no transcript access — the full list of what it touches (8 call sites) and how to verify it in one grep each is in **[PRIVACY.md](PRIVACY.md)**. The short version: it renders numbers the app already has, and nothing leaves your machine.

Platforms: **macOS, Windows and Linux**. No platform-specific paths, binaries, or Node APIs — see PRIVACY.md.

## Install

Requires the Hermes Desktop app (this is an app-side plugin; the CLI/gateway alone won't render it).

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
- **Per-session isolation**: every term is attributed by session id (the focused session's runtime id or its stored id) — no guessing. A `session.usage` event from another session can never land in your chip.
- **Restart-safe**: the agent's counters are process-local and restart at zero, which is why a live-only counter appears to reset; the stored row does not.

## Development

The plugin is a single plain-ESM file (`desktop-plugins/session-tokens/plugin.js`) — loaded uncompiled, no build step, hot-reloaded on save.

**Before saving into a watched folder, run the mount test:**

```bash
node desktop-plugins/session-tokens/smoke.mjs
```

It stubs the plugin SDK, mounts the chip against a real React root inside an error boundary, fires synthetic content chunks, asserts the panel's rows, and **mounts a deliberately broken copy to prove the chip contains its own failures**. It fails on render *and* effect-time errors — `node --check` cannot see an undefined identifier, and a plugin throw reaches the app's ROOT error boundary (which blanks the whole window).

## Caveats

- **Cost is an estimate.** Hermes prices from published rates (`official_docs_snapshot` for Anthropic/OpenAI, `provider_models_api` for OpenRouter/DeepSeek); the provider's invoice can differ. OpenRouter exposes a real per-generation charge, but not through anything a plugin can read.
- **One rate for reasoning.** Hermes prices reasoning at the model's output rate; a few models publish a *different* reasoning rate, where this estimate would be off.
- **Main task only.** Hermes' session row excludes auxiliary work attributed to the same session (background review, title generation) — that lives in `session_model_usage` and is not reachable from the app side.
- **Cache hit includes cache writes.** A write is a miss being cached, priced above plain input; it becomes a hit on the next call. It's 0 on routes without explicit caching (DeepSeek/OpenRouter today), so on Anthropic this number includes a chunk that wasn't strictly a hit.
- **Subagent sessions are excluded** on purpose — their tokens live in their own rows, and the parent row doesn't include them. This matches what `/usage` reports.

## License

MIT — see [LICENSE](LICENSE).
