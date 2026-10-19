/**
 * Session Monitor — the focused session's cumulative token consumption, in the
 * status bar. Adds the streamed text's tokens AS THEY ARRIVE: no smoothing, no
 * interpolation, no tween. The number jumps when the agent produces something.
 *
 *   total = persisted base (state.db)  +  completed calls  +  streamed text
 *
 *  · PERSISTENT BASE — the session row, read without dialing the gateway:
 *    `host.listPersistedSessions(null, {profile, limit})` →
 *    `GET /api/profiles/sessions`. Definition: input + output + cache_read +
 *    cache_write, i.e. the same "Total tokens" as `agent/insights.py` and the
 *    same units as `session_total_tokens`. Restart-safe: the agent's own counters
 *    are process-local and start at zero on resume, so a live-only figure resets.
 *
 *  · COMPLETED CALLS — `session.usage` events **attributed strictly** to this
 *    window's focused session (runtime id, stored id, or the runtime id learned
 *    from that session's own `session.info` — the resume case). The payload's total
 *    is the agent process's cumulative counter for the session, so the FIRST tick of
 *    a plugin lifetime is taken as a baseline (the stored row already contains most
 *    of it) and a regressed counter rebases the same way. Growth is measured
 *    against an anchor that otherwise advances ONLY when the stored row itself
 *    does: a row advance means
 *    the tokens counted live are now persisted, so the live term restarts from the
 *    row. Ordinary polls and manual refreshes leave the term untouched. The fused `host.state.focusedUsage` atom is NOT used:
 *    the app merges rather than replaces that store, so an idle window could
 *    inherit a busy session's numbers.
 *
 *  ISOLATION: every term is attributed strictly to THIS window's focused session
 *  (its runtime id or its stored id, both per-window). Nothing is accepted on a
 *  guess, so a busy session cannot push its numbers into an idle one.
 *
 *  · STREAMED TEXT — every `message.delta` (the answer) and `reasoning.delta`
 *    (the model's reasoning) chunk adds its characters immediately, converted at
 *    CHARS_PER_TOKEN. The counter therefore climbs word by word while the model
 *    thinks and writes. Reset when a tick with a strictly larger total lands,
 *    because that call's text is inside the real figure by then.
 *
 * A stray `~` marks the number only while streamed-text estimate is in play — it
 * is the one part that is an estimate; everything else is Hermes' own count.
 *
 * WHERE IT RENDERS — two doors onto the same detail view: a POPOVER on the status-bar
 * figure (click it, for when the sidebar tab is not open) and a SIDEBAR PANE
 * (`area: 'panes'`, a tab beside SESSIONS, toggled from the zone menu or the command
 * palette). Each runs the panel's own instance, because a pane's tab unmounts with the
 * tab and a status-bar item can be hidden: neither may depend on the other being
 * mounted, and either can be closed without starving the other.
 *
 * PANE — titled "Session monitor" with a refresh button (re-reads the stored row
 * on click): the CONTEXT window (used / max + a fill bar)
 * above the token section, then three rows that PARTITION the session total
 * (Cache hit = cache read + cache write, Cache miss = uncached input, Output =
 * generation incl. reasoning), closed by the Total row they sum to, then a
 * hairline and two derived figures (cache hit rate, cost). The rows carry no
 * percentages: the partition is shown by the Total itself.
 *
 * WHAT IT READS — the complete surface, verifiable by reading this file:
 *   · host.state: focusedStoredSessionId, focusedSessionId, focusedSessionProfile,
 *     model
 *   · host.onEvent: session.usage, session.info, message.delta, reasoning.delta
 *   · host.listPersistedSessions(): the focused profile's session rows, refreshed
 *     every POLL_MS and at turn end
 *   · host.request('session.context_breakdown', {session_id}): the window estimate,
 *     pulled when the panel opens, on refresh, and at turn end — this session's id
 *     only, so the answer is always this session's
 * It never reads prompt or message content — streamed text is measured with
 * `.length` and dropped, only a character count is kept — never writes files or
 * storage, never touches config or credentials, and makes no network requests of
 * its own: every read goes through the app's own local backend.
 *
 * Plain ESM — loaded uncompiled, jsx() only. Imports limited to
 * @hermes/plugin-sdk + react.
 */

import { Component } from 'react'
import { Button, cn, icons, Popover, PopoverContent, PopoverTrigger, host, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'session-monitor'

/** Idle poll: catches writes this process did not make (cron, subagents, another window). */
const POLL_MS = 15_000
/** The Overview's own refresh cadence; it does not wait for the shared poll. */
const OVERVIEW_MS = 5_000

/**
 * Which session the monitor describes: the one in the MAIN area — the chat on screen — not the
 * focused tile. The app's own code separates the two (`$activeSessionId` gates its `mainMatches`,
 * `$focusedRuntimeId` its `tileMatches`), and clicking a pane's tab or the sidebar moves the tile
 * focus without changing the conversation in front of you.
 *
 * Set false (the default) to key on the focused session. `activeSessionId` proved stale in the
 * app — leading with it pinned the context figure to one session for every session, twice, so the
 * focused ids are what the data actually follows. The knob stays for a future desktop whose main
 * area reports a live id.
 */
const PREFER_ACTIVE_CHAT = false

/**
 * Tokens and cost of every session spawned under `rootId` — subagents (and their
 * own subagents), from the SAME page the base row comes from: the row carries
 * `parent_session_id`, so no extra read is needed. Child sessions keep their own
 * rows (the parent's row does not include them), which is why they are summed
 * separately and shown on their own line.
 */
function descendantsOf(page, rootId) {
  const rows = page?.sessions ?? []
  const byParent = new Map()

  for (const row of rows) {
    const parent = row?.parent_session_id
    if (!parent) continue
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(row)
  }

  let tokens = 0
  let cost = 0
  let count = 0
  const seen = new Set([rootId])
  const queue = [rootId]

  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      const id = child?.id ?? child?.resolved_id
      if (!id || seen.has(id)) continue // cycles are impossible, but never loop
      seen.add(id)
      tokens += tokenCount(child)
      cost += pricedCost(id, n(child.actual_cost_usd) > 0 ? n(child.actual_cost_usd) : n(child.estimated_cost_usd) * flexMult(child?.id), rowIsClaudePlan(child))
      count += 1
      queue.push(id)
    }
  }

  return { cost, count, tokens }
}

// Older desktop builds may not export `Button` or the icon set. Falling back costs a
// few lines; letting `undefined` reach React costs `Element type is invalid` inside
// the popover, which is a contained but ugly failure.
const RefreshButton = typeof Button === 'function' ? Button : 'button'
const RefreshIcon = icons?.RefreshCw ?? null
/** Chars per token for the streamed-text term. English prose ≈ 4; code/JSON runs denser. */
const CHARS_PER_TOKEN = 4

const n = value => (typeof value === 'number' ? value : Number(value) || 0)
/** Full digits, grouped — never k/M. Matches Hermes' own `/usage` + insights output. */
const fmt = value => n(value).toLocaleString('en-US')

/** Diagnostic switch — only console.error reaches ~/.hermes/logs/desktop.log. */
const DEBUG = false
let debugBudget = 400
const BOOT = Date.now()

function debug(label, payload) {
  if (!DEBUG || debugBudget <= 0) return

  debugBudget -= 1
  console.error(`[session-monitor] ${label} ${JSON.stringify({ ...payload, t: Date.now() - BOOT })}`)
}

const tokenCount = row =>
  n(row?.input_tokens) + n(row?.output_tokens) + n(row?.cache_read_tokens) + n(row?.cache_write_tokens)

/** Rows carry the stored id; a compressed lineage also exposes resolved_id (the live tip). */
const matches = (row, storedId) =>
  Boolean(storedId) && (row?.id === storedId || row?.resolved_id === storedId)

/**
 * ONE HISTORY PER WINDOW. Every accumulator the figures are computed from lives here rather
 * than in a view, because a view is mounted only while it is on screen: the sidebar pane's
 * tab unmounts with the tab and the status-bar item can be hidden, so per-instance state gave
 * a freshly opened view an EMPTY history — it recomputed the session's numbers without the
 * live counters the other view had accumulated since the app started, which is why clicking
 * the sidebar area changed the values. The display state below is per instance; the history
 * is not.
 */
const SHARED = {
  alias: { current: null },
  best: { current: 0 }, // highest total shown for this session (monotonic guard)
  chars: { current: 0 }, // characters streamed since the last accounted call
  chunks: { current: 0 },
  ctxRef: { current: null },
  frame: { current: 0 },
  lastChunkAt: { current: 0 },
  loadSeq: { current: 0 },
  pullSeq: { current: 0 },
  live: { current: 0 }, // completed-call counter (process cumulative) for this session
  liveAnchor: { current: 0 }, // the counter value the stored row already includes
  rowTotal: { current: 0 },
  tickSeen: { current: false }
}

/**
 * The display values, shared like the history: with a shared high-water mark and per-view
 * copies, the view whose row read happened to be older got pinned at the higher figure while
 * the other moved on — the two views disagreeing, which is what "clicking the sidebar area
 * changes the values" looked like from the outside. One set of values, every view mirrors it.
 */
/**
 * The estate, for the Overview pane: every session row the last read returned, plus the live
 * growth of any session currently running. Ticks arrive for every running session (the gateway
 * emits them per turn), so a delta is recorded per session id BEFORE the ownership filter the
 * single-session view needs — that view keeps refusing anything that is not its own.
 *
 * Deltas, not counters: a `session.usage` total is that process's cumulative for the session, so
 * absolute values are not comparable between sessions.
 */
/**
 * The backend half, when it is installed and enabled: `/api/plugins/session-monitor/summary` reads
 * `session_model_usage`, which the app side cannot — every request, token and dollar over every
 * session, split by provider, task and model. The pane prefers those recorded totals and falls back
 * to the page of rows when the route is absent (an older install, or the gate not yet opened).
 */
const ENRICHED = {
  available: null,
  days: null,
  // The backend half's flex payload — `{ factor, models, mults }`: per-session multipliers for
  // rows whose model the user's `provider_routing` pins to a flex endpoint (billed at exactly
  // half the standard rates). Hermes records its estimates at STANDARD rates (measured: 2.0x
  // against OpenRouter's own charge), so every cost computed from one is scaled by the session's
  // multiplier. Absent means 1 — no discount — which is also the conservative direction.
  flex: null,
  // Consecutive failed summary reads. The Overview switches to the page-of-rows basis when the
  // backend half is absent — but a single slow or failed request used to switch it too, so the
  // totals visibly jumped between two bases (recorded estimates vs re-priced) and back. The basis
  // only changes after this many misses in a row.
  misses: 0,
  totals: null,
  // The providers' OWN reported spend (`confirmed` in the summary), for the Overview's one row
  // that must not be an estimate. Null while unknown.
  confirmed: null,
  // Claude-plan share per session (backend half); see `claudeShareOf`.
  claude: null
}

/** How many failed reads before the Overview gives up on the backend half. */
const ENRICHED_MISSES = 3

/**
 * Claude-plan share per session, from the backend half: the fraction of the session's cost billed to a
 * separate Claude plan (subscription or API credits). Only that fraction is removed; the rest, including
 * OpenRouter calls to Claude models, stays. Tokens are never touched. Absent until the summary lands.
 */
const claudeShareOf = id => (ENRICHED.claude && id ? Math.min(1, Math.max(0, n(ENRICHED.claude[id]))) : 0)

/** A session's recorded cost with its Claude-plan share removed. */
/**
 * A session's recorded cost with the Claude-plan part removed. The backend share map wins when it
 * has an entry (a mixed session keeps its priced share); otherwise the row's own lane decides and a
 * Claude-plan row costs 0 from the start. Never "—", never a climb.
 */
const pricedCost = (id, cost, claudePlan = false) => {
  const value = n(cost)
  const share = claudeShareOf(id)

  if (share > 0) return value * (1 - share)

  return claudePlan ? 0 : value
}

/**
 * Whether a model's calls are billed to a Claude plan (Claude Code login or a native Anthropic key)
 * rather than the cost ledger. A bare Claude id (`sonnet`, `haiku[1m]`, `claude-...`) is that lane; a
 * vendor-prefixed id (`anthropic/claude-...`) is an OpenRouter call and is priced like any other model.
 * Tokens from that lane still count everywhere; only their cost is kept out.
 */
const isClaudeLane = model => {
  const m = String(model ?? '').trim().toLowerCase()

  if (!m || m.includes('/')) return false

  return /^(claude|sonnet|opus|haiku|fable)/.test(m)
}

/** Billing providers whose cost belongs to a Claude plan, not to this ledger. */
const CLAUDE_PLAN_PROVIDERS = new Set(['anthropic', 'claude-subscription-directsdk-experimental'])

/**
 * Whether a session row is billed to a Claude plan. The row carries its own `billing_provider`, so
 * this works with NO summary at all; a bare Claude model id is the fallback for rows that predate
 * that column. A row billed through OpenRouter keeps its cost whatever its model is called.
 */
const rowIsClaudePlan = row => {
  const provider = String(row?.billing_provider ?? '').trim().toLowerCase()

  if (provider) return CLAUDE_PLAN_PROVIDERS.has(provider)

  return isClaudeLane(row?.model)
}

/**
 * The flex multiplier for a recorded row: 1 unless the backend half marked this session's usage
 * as flex-pinned. Applied where a cost is COMPUTED from `estimated_cost_usd` and never to
 * `actual_cost_usd` (a recorded charge is already the bill) — and computed at the point of use
 * rather than stored in the row state, because the summary carrying the multipliers can land
 * after the row read does, and the figure must correct itself when it does.
 */
const flexMult = id => {
  const mult = n(ENRICHED.flex?.mults?.[id])

  return mult > 0 ? mult : 1
}
/** The plugin's own REST namespace (`ctx.rest`), captured at registration. */
const restRef = { current: null }

const AGG = {
  cost: 0,
  live: new Map(), // session id -> { last: counter, tokens: counted live since the row read }
  requests: 0, // API calls observed across sessions while this app instance has been running
  rowTotals: new Map(), // session id -> row total last seen (a written row absorbs its delta)
  sessions: 0,
  tokens: 0
}

/**
 * The clock every period uses: the USER'S OWN. A day starts at 00:00 where they are, which is what
 * "today" means to the person reading it — and it is what the backend is told to cut its days on,
 * so the rows and the chart agree. `Intl` reports the zone of the machine the app is running on;
 * `UTC` is the fallback for a runtime that cannot answer.
 */
const PERIOD_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()

/** Minutes east of UTC right now, as the backend needs it when it cannot load a tz database. */
const PERIOD_OFFSET = -new Date().getTimezoneOffset()

/** How the zone is named on screen (`GMT+7`), or '' when the runtime will not say. */
const zoneLabel = (() => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: PERIOD_TZ, timeZoneName: 'short' }).formatToParts(new Date())

    return (parts.find(part => part.type === 'timeZoneName') || {}).value || ''
  } catch {
    return ''
  }
})()

const utcDay = (now = Date.now()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone: PERIOD_TZ, year: 'numeric' }).format(new Date(now))
  } catch {
    // `Intl` with an explicit timezone is available in every runtime this app ships; the fallback
    // is here for a stubbed or ancient one, and UTC needs no offset arithmetic.
    const utc = new Date(now)
    const pad = value => String(value).padStart(2, '0')

    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`
  }
}

const utcMonth = (now = Date.now()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { month: '2-digit', timeZone: PERIOD_TZ, year: 'numeric' }).format(new Date(now))
  } catch {
    const utc = new Date(now)
    const pad = value => String(value).padStart(2, '0')

    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}`
  }
}

/**
 * A spend period, observed — not reconstructed. Hermes stores cumulative per-route totals with
 * only a first/last timestamp, so no local table can say exactly how much of a multi-day bucket
 * burned inside the period. Each period therefore starts at zero on first observation and adds
 * only spend seen afterwards: live `session.usage` deltas, plus recorded increments a row or
 * summary read reports while this plugin lifetime is watching. Daily and Monthly share the shape;
 * only the seed and the reset boundary differ.
 */
function makePeriod(kind) {
  return {
    baseCost: 0, // last authoritative summary total seen (same-source growth is the period's spend)
    baseTokens: 0,
    cost: 0, // confirmed recorded cost increments inside the period
    key: '',
    kind, // 'day' resets at UTC midnight, 'month' on the first of the month
    live: new Map(), // session id -> { calls: 0, last: counter, tokens: observed, not yet recorded }
    rows: new Map(), // stored row id -> { cost, tokens } last seen (rows-source growth is the period's spend)
    seedCost: 0, // backend half's seed: buckets first seen inside the period, captured once per period
    seedSet: false,
    seedTokens: 0,
    source: '', // which recorded base owns the confirmation right now: 'rows' or 'summary'
    tokens: 0 // confirmed recorded token increments inside the period
  }
}

const TODAY = makePeriod('day')
const MONTH = makePeriod('month')
const PERIODS = [TODAY, MONTH]

const periodKey = (period, now = Date.now()) => period.kind === 'month' ? utcMonth(now) : utcDay(now)

/** Roll a period over when UTC says so; the next observation starts a fresh zero. */
function touchPeriod(period) {
  const key = periodKey(period)

  if (period.key !== key) {
    period.baseCost = 0
    period.baseTokens = 0
    period.cost = 0
    period.key = key
    period.live.clear()
    period.rows.clear()
    period.seedCost = 0
    period.seedSet = false
    period.seedTokens = 0
    period.source = ''
    period.tokens = 0
  }

  return period.key
}

/** A completed-call delta seen inside the period. The first sighting is a baseline, like the main total. */
function recordPeriodTick(period, sessionId, total, claude = false) {
  if (!sessionId || typeof total !== 'number') return

  touchPeriod(period)

  const entry = period.live.get(sessionId) ?? { calls: 0, last: total, tokens: 0, claude }

  entry.claude = claude

  if (total > entry.last) entry.tokens += total - entry.last

  entry.last = total
  period.live.set(sessionId, entry)
}

const periodLiveTokens = period => {
  let tokens = 0

  period.live.forEach(entry => {
    tokens += entry.tokens
  })

  return tokens
}

/** Live tokens whose cost is priced: every session except the Claude-plan lane. */
const periodLivePricedTokens = period => {
  let tokens = 0

  period.live.forEach(entry => {
    if (!entry.claude) tokens += entry.tokens
  })

  return tokens
}

/**
 * A page row that grew while being watched has folded live tokens into the record. Transfer the
 * absorbed session's observed delta into the period's confirmed figure (first sighting of a row
 * is a baseline and claims nothing), and count the row's own cost growth as the period's actual.
 */
function confirmPeriodRow(period, candidate) {
  if (!candidate) return

  touchPeriod(period)

  if (period.source && period.source !== 'rows') {
    period.rows.clear()
    period.source = 'rows'
  } else if (!period.source) {
    period.source = 'rows'
  }

  const id = candidate?.id ?? ''

  if (!id) return

  const tokens = tokenCount(candidate)
  const cost = pricedCost(id, n(candidate.actual_cost_usd) > 0 ? n(candidate.actual_cost_usd) : n(candidate.estimated_cost_usd) * flexMult(id), rowIsClaudePlan(candidate))
  const prev = period.rows.get(id)

  if (!prev) {
    period.rows.set(id, { cost, tokens })
    return
  }

  if (tokens > prev.tokens) {
    period.tokens += tokens - prev.tokens
    period.live.delete(id)

    if (candidate.resolved_id) period.live.delete(candidate.resolved_id)
  }

  if (cost > prev.cost) period.cost += cost - prev.cost

  period.rows.set(id, { cost, tokens })
}

/**
 * The backend half's absolute totals, when they move forward while being watched. Growth under
 * the same source is the period's recorded spend; an unchanged fetch keeps the live deltas (the
 * write may simply not have landed yet), and a correction rebases without erasing them.
 */
function notePeriodSummary(period, totals, seed) {
  const tokens = n(totals?.tokens)
  const cost = n(totals?.cost)

  touchPeriod(period)

  if (period.source !== 'summary') {
    // First summary of the period seeds it with what the record already holds for buckets
    // first seen inside the period — spend that happened before this plugin lifetime opened.
    // The row path may already have confirmed some of those same writes, so only the
    // remainder is seeded; afterwards the seed is frozen and everything new flows through
    // live/confirmed.
    if (!period.seedSet) {
      period.seedTokens = Math.max(0, n(seed?.tokens) - period.tokens)
      period.seedCost = Math.max(0, n(seed?.cost) - period.cost)
      period.seedSet = true
    }

    period.baseCost = cost
    period.baseTokens = tokens
    period.source = 'summary'
    return
  }

  const grewTokens = tokens > period.baseTokens
  const grewCost = cost > period.baseCost

  if (grewTokens) {
    period.tokens += tokens - period.baseTokens
    period.baseTokens = tokens
    period.live.clear()
  } else if (tokens < period.baseTokens) {
    period.baseTokens = tokens
  }

  if (grewCost) {
    period.cost += cost - period.baseCost
    period.baseCost = cost
  } else if (cost < period.baseCost) {
    period.baseCost = cost
  }
}

/** A period on screen: the backend's seed, confirmed recorded increments, and whatever is still in flight. */
function periodSnapshot(period, streamed = 0, streamPriced = true) {
  touchPeriod(period)

  const liveTokens = periodLiveTokens(period) + Math.max(0, n(streamed))
  const livePriced = periodLivePricedTokens(period) + (streamPriced ? Math.max(0, n(streamed)) : 0)
  const baseTokens = ENRICHED.totals ? n(ENRICHED.totals.tokens) : AGG.tokens
  const baseCost = ENRICHED.totals ? n(ENRICHED.totals.cost) : AGG.cost
  const rateTokens = ENRICHED.totals ? n(ENRICHED.totals.pricedTokens ?? ENRICHED.totals.tokens) : baseTokens
  const rate = rateTokens > 0 && baseCost > 0 ? baseCost / rateTokens : 0

  return {
    cost: period.seedCost + period.cost + livePriced * rate,
    live: liveTokens > 0,
    tokens: period.seedTokens + period.tokens + liveTokens
  }
}

/** What the Overview renders: the rows, plus every running session's live deltas. */
function overviewSnapshot() {
  let liveTokens = 0

  let livePriced = 0

  AGG.live.forEach(entry => {
    liveTokens += entry.tokens
    if (!entry.claude) livePriced += entry.tokens
  })

  // In-flight growth priced at the aggregate's own blended rate, marked as the estimate it is.
  // With the backend totals present the priced basis wins: AGG.cost excludes Claude-plan cost while
  // AGG.tokens still counts Claude tokens, so the row-derived rate would under-price the live tokens.
  const rate = ENRICHED.totals ? 0 : (AGG.tokens > 0 && AGG.cost > 0 ? AGG.cost / AGG.tokens : 0)

  // The backend half's recorded totals when they are available — every session, every provider —
  // otherwise the page of rows this view could read for itself.
  const baseCost = ENRICHED.totals ? ENRICHED.totals.cost : AGG.cost
  const baseCalls = ENRICHED.totals ? ENRICHED.totals.calls : AGG.requests
  const baseTokens = ENRICHED.totals ? ENRICHED.totals.tokens : AGG.tokens
  const rateTokens = ENRICHED.totals ? n(ENRICHED.totals.pricedTokens ?? baseTokens) : baseTokens
  const baseRate = rateTokens > 0 && baseCost > 0 ? baseCost / rateTokens : 0

  return {
    cost: baseCost + livePriced * (rate || baseRate),
    days: ENRICHED.days,
    costLive: livePriced > 0 && (rate > 0 || baseRate > 0),
    liveTokens,
    requests: baseCalls,
    sessions: ENRICHED.totals ? ENRICHED.totals.sessions : AGG.sessions,
    tokens: baseTokens + liveTokens,
    pricedTokens: rateTokens + livePriced
  }
}

/**
 * The last context window seen for each session, keyed by its identity. Switching sessions used to
 * clear the Context row and then wait for a fresh `session.context_breakdown` — a gateway RPC that
 * estimates from the live prompt, tools and transcript, so it is the slowest thing the pane asks
 * for and it was on the critical path of every switch. The memo lets a switch paint the figure it
 * already knows and refresh it in the background; the stamp check still stops one session's window
 * from ever appearing under another's name.
 */
const CTX_MEMO = new Map()

/**
 * The last TOTALS row seen for each session, keyed the same way. The context row was memoized
 * because a switch blanked it; the Cache hit / Cache miss / Output / Total / Cost row suffered
 * the same fate and had no memo — a switch cleared it and waited for the session-list read,
 * which can miss for seconds (the session is not in the loaded page) or fail, so the panel
 * showed zeros for a session whose figures it had already displayed ("it resets everything to
 * zero... it happens every time I switch the session window"). The memo lets a switch paint the
 * row it already knows and refresh it in the background; a session never seen before in this app
 * run has no memo and starts empty, as it must.
 */
const ROW_MEMO = new Map()

const UI = { base: null, ctx: null, overview: null, refreshing: false, rowState: 'pending', subagents: null, version: 0 }
const UI_SUBSCRIBERS = new Set()

function uiSet(patch) {
  Object.assign(UI, patch)
  UI.version += 1
  UI_SUBSCRIBERS.forEach(listen => listen(UI.version))
}

/** Read the shared display values, re-rendering when any view writes them. */
function useUI() {
  const [, bump] = useState(0)

  useEffect(() => {
    const listen = () => bump(tick => tick + 1)

    UI_SUBSCRIBERS.add(listen)

    return () => UI_SUBSCRIBERS.delete(listen)
  }, [])

  return UI
}

/** Every mounted view's repaint trigger, so one subscriber can refresh all of them. */
const REPAINTS = new Set()
/**
 * The engine runs ONCE per window, however many views are mounted — but its handles live here, not
 * in the view that happened to install them. A view's tab closing must not tear the engine down
 * while another view is still on screen: doing that left a mounted view with no subscriptions and
 * no poll, so nothing moved until a session change forced a read ("the Overview only updates when I
 * click a session"). Teardown now happens on the last exit, and a later mount re-arms.
 */
const OWNERS = { events: 0, poll: 0 }
const ENGINE = { offs: [], timer: 0 }

/**
 * The monitor itself: subscriptions, the poll, the context pulls and every figure.
 * A hook so both views — the status-bar readout and the sidebar pane — can run it;
 * each mount owns its instance, and each stays correct on its own (the pane is only
 * mounted while its tab is showing, so it cannot rely on the chip's instance).
 */
function useMonitor() {
  // WHICH SESSION. The active chat — the one on screen — leads, not the focused tile:
  // clicking around the sidebar moves focus (tiles, projects, panes) without changing the
  // chat being worked in, and the monitor described the tile the user had just clicked
  // instead of the conversation in front of them. The app's own context gauge reads
  // `activeSessionId` for the same reason; the focused ids remain as the fallback for
  // drafts and older desktops that do not expose it.
  const focusedStoredId = useValue(host.state.focusedStoredSessionId)
  const focusedRuntimeId = useValue(host.state.focusedSessionId)
  // Precedence restored to the version that worked: the FOCUSED session leads, exactly as it did
  // before I inverted this. `activeSessionId` was my inference about which atom tracks the chat on
  // screen; in the app it evidently does not move with a session switch, so keying on it pinned the
  // identity to a stale session — the context row kept the previous session's figure (and every
  // pull was addressed to the wrong runtime id). The active id remains only a fallback for when the
  // focused ids are absent.
  const activeRuntimeId = typeof host.state.activeSessionId !== 'undefined' ? useValue(host.state.activeSessionId) : null
  const runtimeId = PREFER_ACTIVE_CHAT ? activeRuntimeId ?? focusedRuntimeId : focusedRuntimeId ?? activeRuntimeId
  const storedId = focusedStoredId
  // The identity every term is attributed to, and the key the per-session reset is tied to: if
  // EITHER half changes, the figures on screen belong to the previous session. Keying on one half
  // (the focused stored id, or the active runtime id alone) left a window where the previous
  // session's live counters were still displayed — and, before this, where an id resolved for
  // another session could remain in the ownership filter.
  const identityKey = `${runtimeId ?? ''}|${storedId ?? ''}`
  // Either identity may be the one the earlier visit stored: a resumed session arrives under a new
  // runtime id, and a reattached one may only match on the stored id.
  const memoFor = () => (storedId && CTX_MEMO.get(storedId)) || (runtimeId && CTX_MEMO.get(runtimeId)) || null
  const rowMemoFor = () => (storedId && ROW_MEMO.get(storedId)) || (runtimeId && ROW_MEMO.get(runtimeId)) || null
  const profile = useValue(host.state.focusedSessionProfile)
  // The model decides the context WINDOW, so a switch has to invalidate it.
  const model = useValue(host.state.model)

  const { base, ctx, overview, rowState, subagents } = useUI()
  const [refreshing, setRefreshing] = useState(false)
  // Writes go through the shared store, so every view of this window shows the same values.
  // ('pending' until the row read settles: without that gate the chip painted base(null→0) +
  // the live PROCESS counter instead of the session total for the first ~100ms.)
  const setBase = value => uiSet({ base: value })
  const setCtx = value => uiSet({ ctx: value })
  const setRowState = value => uiSet({ rowState: value })
  const setSubagents = value => uiSet({ subagents: value })
  const ctxRef = SHARED.ctxRef // mirror with a stable read path for the pullers
  const [, repaint] = useState(0)

  const live = SHARED.live // shared: a view that mounts late inherits this history
  const liveAnchor = SHARED.liveAnchor
  const rowTotalRef = SHARED.rowTotal // stored total at the last read — detects a row advance
  const tickSeen = SHARED.tickSeen // has the counter's baseline been seen yet
  // In-flight request guards. Reads are async, and a slow one can land AFTER a newer one
  // (a refresh racing the poll, or a session switch mid-read) — which painted the previous
  // session's row into the current one: the "refresh shows the wrong values" report.
  // The guards are shared with the state: any read supersedes the reads before it, whichever
  // view issued them, so a slow response can never write stale figures into the one store.
  const loadSeq = SHARED.loadSeq
  const pullSeq = SHARED.pullSeq
  const chars = SHARED.chars
  const chunks = SHARED.chunks
  const lastChunkAt = SHARED.lastChunkAt
  const best = SHARED.best
  const frame = SHARED.frame
  const storedRef = useRef(storedId)
  // The app's OWN idea of the focused session, kept alongside the id the row read adopts. Both are
  // authorities on "this window's session", and they disagree in exactly the interesting moment: a
  // read that resolved a different row leaves the ref on one id while the app's atoms — the ids the
  // events carry — still hold the other.
  const storedAtomRef = useRef(storedId)
  const runtimeRef = useRef(runtimeId)
  // Runtime id learned from this session's own `session.info` (payload carries the
  // STORED id, so this is proof, not a guess). Needed because a resumed session
  // runs under a NEW runtime id while this window may still hold the previous one:
  // without it, every live tick is rejected and the counter freezes until the
  // window's own atoms refresh (which is what "it only updates when I switch tabs"
  // was). Cleared whenever the window's own ids change.
  const aliasRef = useRef(null)
  // Events for one chat arrive under DIFFERENT ids depending on the emitter
  // (observed: usage/message.delta on one, thinking.delta/session.info on
  // another), so match an alias set rather than a single id.

  storedRef.current = storedId
  storedAtomRef.current = storedId
  runtimeRef.current = runtimeId

  // Repaint on the next animation frame after a change: ≤16ms of latency, and
  // chunks arrive faster than any display can show. No tween — the rendered
  // number IS the computed total.
  // Repaint THIS view, and register it so the window's single subscriber can repaint it too
  // (a view that is not the subscriber still has to move when the numbers do).
  const mine = useCallback(() => repaint(tick => tick + 1), [])

  useEffect(() => {
    REPAINTS.add(mine)

    return () => REPAINTS.delete(mine)
  }, [mine])

  const schedule = useCallback(() => {
    if (frame.current) return

    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      REPAINTS.forEach(fn => fn())
    })
  }, [])

  useEffect(() => () => frame.current && cancelAnimationFrame(frame.current), [])

  // Context fields ride on the same usage payloads as the token totals. The
  // callers check attribution first — the usage event by its runtime id, session
  // info by its stored id — so what lands here is always THIS session's window.
  // Declared ABOVE the events effect: that effect's dependency array is evaluated
  // during render, so a later `const` would sit in its temporal dead zone.
  const takeContext = useCallback((usage, forRuntime) => {
    if (!usage) return

    const used = n(usage.context_used)
    const max = n(usage.context_max)

    if (used > 0 || max > 0) {
      // STAMPED with the session it was measured for: a context figure carries no identity of its
      // own, so an unstamped one could be measured for one session and displayed under another —
      // the "same context across every session" report. Views render it only while the stamp
      // matches the chat on screen.
      const next = {
        estimated: Boolean(usage.context_estimated),
        forRuntime: forRuntime ?? null,
        // The runtime id alone was too strict: a resumed session runs under a NEW runtime id while
        // its stored id stays, so a figure measured for it — pushed before the window's own atoms
        // caught up, or relayed — carried a stamp that no longer matched and the row stayed blank.
        // The stored id is per-session and stable, so it is the better half of the stamp.
        forStored: [storedRef.current, storedAtomRef.current].filter(Boolean),
        max,
        percent: n(usage.context_percent),
        used
      }

      ctxRef.current = next
      // Keyed by the session's own ids, read from the refs: a render-scoped key goes stale the
      // moment the session changes, and would file one session's window under another's name.
      if (storedRef.current) CTX_MEMO.set(storedRef.current, next)
      if (forRuntime) CTX_MEMO.set(forRuntime, next)
      setCtx(next)
    }
  }, [])

  useEffect(() => {
    if (typeof host.onEvent !== 'function') return undefined

    // One subscriber per window: a second view must not re-register the same handlers
    // (that would double-count the streamed text and double the reads).
    OWNERS.events += 1

    if (OWNERS.events > 1) {
      return () => {
        OWNERS.events -= 1
      }
    }

    // STRICT ownership: an event belongs to this window's focused session only if
    // it carries that session's runtime id or its stored id. Both are per-window
    // focused identities, so this cannot admit another session's stream — the old
    // "accept unknown ids while the chat is busy" fallback is what let an idle
    // session's chip count this session's tokens. Verified live: the focused
    // runtime id DOES match its own usage/reasoning events (focusedRuntime
    // "0734c261" == sid "0734c261").
    // Ownership is decided by the atoms' CURRENT values (runtimeRef/storedRef, rewritten every
    // render) plus the runtime id learned from this session's own session.info. Nothing else is
    // ever adopted, so a session cannot inherit another's stream.
    const forFocused = id =>
      Boolean(id) && (id === runtimeRef.current || id === storedRef.current || id === aliasRef.current)

    const countText = event => {
      if (!forFocused(event.session_id)) return

      const text = event.payload?.text

      if (typeof text !== 'string' || !text) return

      const now = Date.now()
      const gap = lastChunkAt.current ? now - lastChunkAt.current : 0
      const before = Math.floor(chars.current / CHARS_PER_TOKEN)

      lastChunkAt.current = now
      chars.current += text.length
      chunks.current += 1

      // Repaint only when the rendered integer can actually move: a chunk that
      // adds no whole token would otherwise re-render for nothing, which reads
      // as flicker on a busy stream.
      if (Math.floor(chars.current / CHARS_PER_TOKEN) !== before) schedule()

      debug('chunk', {
        charsCall: chars.current,
        chunk: text.length,
        gapMs: gap,
        n: chunks.current,
        session: event.session_id,
        type: event.type
      })
      schedule()
    }

    const offs = [
      // Completed calls — the ONLY source of the live term (see the note on the
      // fused atom above). Strictly attributed, so one window can never count
      // another session's tokens.
      host.onEvent('session.usage', event => {
        // Recorded for the OVERVIEW first — it counts every running session, while the view below
        // must keep refusing anything that is not this session's.
        const anyTotal = event.payload?.usage?.total

        const anyCalls = event.payload?.usage?.calls

        if (typeof anyTotal === 'number' && event.session_id) {
          // The lane of the model this tick ran on: Claude-plan tokens count, their cost does not.
          const claude = isClaudeLane(event.payload?.usage?.model)
          const entry = AGG.live.get(event.session_id) ?? { calls: 0, last: anyTotal, tokens: 0, claude }

          entry.claude = claude

          if (anyTotal > entry.last) entry.tokens += anyTotal - entry.last

          // Requests are counted as they are OBSERVED: the session row carries no request total
          // (only tool calls), and the authoritative per-session count lives in a table the
          // renderer cannot read. Lives on the entry so it survives the token deltas.
          if (typeof anyCalls === 'number' && anyCalls > (entry.calls ?? 0)) {
            AGG.requests += anyCalls - (entry.calls ?? 0)
            entry.calls = anyCalls
          }

          entry.last = anyTotal
          AGG.live.set(event.session_id, entry)
          PERIODS.forEach(period => recordPeriodTick(period, event.session_id, anyTotal, claude))
          uiSet({ overview: overviewSnapshot() })
        }

        if (!forFocused(event.session_id)) return

        const usage = event.payload?.usage
        const total = usage?.total

        takeContext(usage, event.session_id)

        if (
          typeof total === 'number' &&
          (total > live.current || !tickSeen.current || total < live.current * 0.5)
        ) {
          onTick(total)
        }
      }),
      // `session.info` carries the same usage snapshot when a session is opened or
      // resumed — the only way the context row paints before the next API call.
      // Attributed by STORED id: this event carries no runtime id of its own.
      host.onEvent('session.info', event => {
        const claimed = event.payload?.stored_session_id

        // Refused unless it names this session by one of the two authorities. Testing the adopted id
        // alone left a resumed or reattached session — the usual state right after a restart — with
        // its own pushed window rejected, so the row never filled.
        if (!claimed || (claimed !== storedRef.current && claimed !== storedAtomRef.current)) return

        // Same session, possibly a new runtime id (resume/reconnect): adopt it, so
        // the live ticks that follow are attributed instead of discarded.
        if (typeof event.session_id === 'string' && event.session_id) {
          aliasRef.current = event.session_id
        }

        takeContext(event.payload?.usage, event.session_id)
      }),
      // The two CONTENT streams: `message.delta` is the answer, `reasoning.delta`
      // is the model thinking — those are the words that cost output tokens.
      // `thinking.delta` is deliberately NOT counted: the backend fires it from
      // `thinking_callback` with short STATUS strings ("✻ Thinking…", and empty
      // strings at call start/error), not with reasoning text, so counting it
      // added fake characters and never moved while the model actually thought.
      host.onEvent('message.delta', countText),
      host.onEvent('reasoning.delta', countText)
    ]

    ENGINE.offs = offs

    return () => {
      OWNERS.events -= 1

      // Same rule as the poll: the LAST view out unsubscribes, and whichever view that is owns the
      // handles — not necessarily the one that installed them.
      if (OWNERS.events === 0) {
        ENGINE.offs.forEach(off => off())
        ENGINE.offs = []
      }
    }
  }, [schedule, takeContext])

  // Completed calls arrive as `session.usage` EVENTS, attributed strictly below.
  // The fused `host.state.focusedUsage` atom is deliberately NOT used: the app
  // merges rather than replaces that store, so a window whose session is idle can
  // inherit ANOTHER session's numbers — which is how one session's chip made an
  // idle session's chip climb.
  // The push payloads only flow while a turn runs, so a panel opened on an idle
  // session (or right after this plugin reloads) had nothing to paint and stayed
  // blank until the next call. This is the same on-demand read the app's own Context
  // usage panel makes — `session.context_breakdown` answers for a session that has
  // not spoken yet (it estimates from the live system prompt + tools + transcript:
  // a read-only chars/4 pass, no provider call, no cache impact) — and it is
  // addressed to THIS window's session id, so the answer cannot be another session's.
  const pullContext = useCallback(
    async ({ force = false, retry = false } = {}) => {
      // `force` also means "the memo painted a remembered figure, refresh it now": a stamped value
      // from an earlier visit is a starting point, never a reason to skip the read.
      if (!force && ctxRef.current !== null) return // pushed (measured) data beats an estimate
      if (typeof host.request !== 'function') return
      if (!runtimeId) return // a draft has no session to ask about

      const seq = ++pullSeq.current
      const wantRuntime = runtimeId // the session this pull was issued FOR

      try {
        const breakdown = await host.request('session.context_breakdown', { session_id: wantRuntime })

        // Only the newest pull for the session still on screen may paint.
        if (seq !== pullSeq.current || runtimeRef.current !== wantRuntime) return

        takeContext(breakdown, wantRuntime)
      } catch {
        // The backend rejects a runtime id it no longer holds in memory (a detached or
        // reaped session) and answers nothing until the session is live again, so the
        // pull has to be retried rather than fired once. One quick retry covers a
        // resume in progress; the poll keeps trying afterwards. The row stays "—"
        // meanwhile instead of inventing a number.
        if (!retry) setTimeout(() => void pullContext({ force: true, retry: true }), 1500)
      }
    },
    [runtimeId, takeContext]
  )

  const onTick = useCallback(
    total => {
      // `total` is the agent PROCESS's cumulative counter for this session
      // (`agent.session_total_tokens`), while the stored row accumulates across
      // processes. The row therefore already contains most of the counter at any
      // moment, so the first tick of this plugin lifetime is a BASELINE, not growth:
      // counting it as growth inflated the total by everything this process had
      // written so far (millions of tokens, visible until the next session switch,
      // which is the "wrong total until I switch tabs" report).
      //
      // A clear regression (the counter is far below the last one) means the agent
      // process restarted its counters — a resume. Rebase there rather than freeze;
      // again claiming nothing, because the row, not the counter, holds what was
      // already written.
      const first = !tickSeen.current
      const restarted = !first && total < live.current * 0.5

      if (first || restarted) {
        liveAnchor.current = total
        tickSeen.current = true
      }

      live.current = total
      chars.current = 0 // this call's text is inside `total` now
      schedule()
    },
    [schedule]
  )

  const load = useCallback(async () => {
    if (!storedId) {
      setBase(null)
      setRowState('unavailable')
      return
    }

    const seq = ++loadSeq.current
    const wantStored = storedId // the session this read was issued FOR

    // Snapshot BEFORE the await so growth during the fetch is not lost.
    const liveNow = live.current

    try {
      const page = await host.listPersistedSessions(null, { limit: 500, profile })

      // Drop a superseded or now-unrelated response BEFORE touching any state: the window
      // may have moved on while this read was in flight.
      if (seq !== loadSeq.current) return
      if (storedRef.current !== wantStored && !(runtimeId && (page?.sessions ?? []).some(candidate => candidate?.resolved_id === runtimeId))) return

      // Match the stored id when the focused tile is the chat on screen; otherwise resolve
      // the ACTIVE chat by its runtime id (`resolved_id` on the row) and adopt that row's
      // stored id, so the figures, the subagents and the guards all describe one session.
      const row = (page?.sessions ?? []).find(
        candidate => matches(candidate, wantStored) || (runtimeId && candidate?.resolved_id === runtimeId)
      )
      const effectiveStored = row?.id ?? wantStored

      // Adopt the resolved stored id: with the main area's runtime id leading, the focused stored
      // id can belong to a different session, and every guard that compares stored ids (the
      // session.info attribution, the resets) has to see the one actually on screen.
      if (row?.id && row.id !== storedRef.current) storedRef.current = row.id

      setSubagents(row ? descendantsOf(page, effectiveStored) : null)

      let aggCost = 0
      let aggTokens = 0

      for (const candidate of page?.sessions ?? []) {
        const candidateId = candidate?.id ?? ''

        if (!candidateId) continue

        const candidateTotal = tokenCount(candidate)

        aggCost += pricedCost(candidateId, n(candidate.actual_cost_usd) > 0 ? n(candidate.actual_cost_usd) : n(candidate.estimated_cost_usd) * flexMult(candidateId), rowIsClaudePlan(candidate))
        aggTokens += candidateTotal

        // A row that grew has had its live tokens folded in: drop the delta so they count once.
        // BOTH ids — a tick carries the RUNTIME id while the row is keyed by its STORED id, and
        // matching only the stored one left every delta unabsorbed (the totals then double-counted
        // every running session; caught by the Overview's confirmation contract).
        const seenBefore = AGG.rowTotals.get(candidateId)

        if (seenBefore === undefined || candidateTotal > seenBefore) {
          AGG.live.delete(candidateId)

          if (candidate.resolved_id) AGG.live.delete(candidate.resolved_id)
        }

        AGG.rowTotals.set(candidateId, candidateTotal)

        if (!ENRICHED.totals) PERIODS.forEach(period => confirmPeriodRow(period, candidate))
      }

      AGG.cost = aggCost
      AGG.sessions = (page?.sessions ?? []).length
      AGG.tokens = aggTokens
      uiSet({ overview: overviewSnapshot() })

      if (row) {
        const rowTotal = tokenCount(row)

        // The anchor — the counter value the stored row already includes — moves
        // ONLY when the row itself advances (a turn ended and was written). Moving
        // it on every read is what made a manual refresh (and the 15 s poll) discard
        // the live term the display was carrying: the number then sat still at its
        // previous value until new growth re-earned the discarded amount.
        if (rowTotal > rowTotalRef.current) liveAnchor.current = liveNow

        rowTotalRef.current = rowTotal

        debug('row', { rowTotal: tokenCount(row), storedId: effectiveStored })
        setRowState('ok')
        const rowSnapshot = {
          cacheRead: n(row.cache_read_tokens),
          cacheWrite: n(row.cache_write_tokens),
          in: n(row.input_tokens),
          // Cost as Hermes records it. NOTE: this is an ESTIMATE derived from the
          // model's published rates (cost_status 'estimated'); OpenRouter's own
          // per-generation charge is not persisted anywhere locally, so it cannot
          // be labelled as a bill. It is a STANDARD-rate figure even for flex-pinned
          // routes (measured: 2.0x against OpenRouter's own charge), so every cost
          // derived from it is scaled by the session's flex multiplier where it is
          // computed (see `flexMult` and `mainCost`).
          // Cache hit rate, Hermes' own definition: cache_read ÷ prompt tokens
          // (input + cache_read + cache_write), rounded — identical to the
          // gateway's `cache_hit_pct` and the built-in Cache hit rate item.
          // Two decimals on purpose: Hermes rounds this to a whole percent, which
          // flattens 99.79% to "100%" — the finer figure is what tells you a cache
          // break actually happened.
          cacheHit: (() => {
            const prompt = n(row.input_tokens) + n(row.cache_read_tokens) + n(row.cache_write_tokens)

            return prompt > 0 && n(row.cache_read_tokens) > 0
              ? Math.max(0, Math.min(100, Math.round((n(row.cache_read_tokens) / prompt) * 10000) / 100))
              : null
          })(),
          cost: n(row.estimated_cost_usd),
          claudePlan: rowIsClaudePlan(row),
          costId: row.id ?? effectiveStored,
          costSource: row.cost_source ?? '',
          costStatus: row.cost_status ?? '',
          actualCost: n(row.actual_cost_usd),
          out: n(row.output_tokens),
          total: rowTotal
        }

        // Keyed like the context memo — every stored id this session is known by (the adopted
        // one and the read's own) plus the runtime id the row resolved to, so a switch finds
        // the row under either identity (a resumed session arrives under a new runtime id, a
        // reattached one may only match on the stored id).
        if (row.id) ROW_MEMO.set(row.id, rowSnapshot)
        if (wantStored && wantStored !== row.id) ROW_MEMO.set(wantStored, rowSnapshot)

        const rowRuntime = row.resolved_id ?? runtimeId

        if (rowRuntime) ROW_MEMO.set(rowRuntime, rowSnapshot)
        setBase(rowSnapshot)
        return
      }

      setRowState('unavailable')
    } catch (error) {
      // A failed read must not touch the anchor either, and must not overwrite what a
      // newer read has already applied.
      if (seq === loadSeq.current && storedRef.current === wantStored) setRowState('unavailable')
    }
  }, [profile, storedId])

  // Manual refresh (declared AFTER `load`: its dependency array is evaluated during
  // render, so referencing a later `const` would be a temporal-dead-zone error).
  // Manual refresh for the panel's header button: re-read the stored row now
  // instead of waiting for the next poll. `refreshing` only drives the spinner.
  /** Ask the backend half for the recorded totals; silently absent when it is not installed. */
  const loadRecorded = useCallback(async rest => {
    if (typeof rest !== 'function') return

    try {
      const summary = await rest('summary')

      // The flex multipliers ride every good summary, totals or not — they must land as soon as
      // the backend half speaks, since every cost computed from a recorded estimate scales by
      // them. The repaint matters: a totals-less summary would otherwise leave the corrected
      // figures waiting for an unrelated render.
      if (summary && 'claudeShareBySession' in summary) {
        ENRICHED.claude = summary.claudeShareBySession ?? {}
        uiSet({})
      }
      if (summary?.flex) {
        ENRICHED.flex = summary.flex
        uiSet({})
      }
      if (summary && 'confirmed' in summary) {
        ENRICHED.confirmed = summary.confirmed ?? null
        uiSet({})
      }

      if (summary?.totals) {
        ENRICHED.available = true
        ENRICHED.misses = 0
        ENRICHED.totals = summary.totals
        ENRICHED.days = Array.isArray(summary.days) ? summary.days : null
        notePeriodSummary(TODAY, summary.totals, summary.today)
        notePeriodSummary(MONTH, summary.totals, summary.month)
        // The recorded totals now account for everything counted so far, so the live deltas are
        // dropped — otherwise each fetch would add them to the total it already includes.
        AGG.live.clear()
        AGG.requests = 0
        uiSet({ overview: overviewSnapshot() })
      }
    } catch {
      // A failed read keeps the last good totals on screen until the failures are clearly not
      // transient — then the page of rows becomes the source again.
      ENRICHED.misses += 1

      if (ENRICHED.misses >= ENRICHED_MISSES) {
        ENRICHED.available = false
        ENRICHED.days = null
        ENRICHED.flex = null
        ENRICHED.totals = null
      }
    }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await load()
      await pullContext({ force: true })
      await loadRecorded(restRef.current)
    } finally {
      setRefreshing(false)
    }
  }, [load, pullContext])


  // New session: every term belongs to the previous one. Keyed on the ACTIVE chat's runtime id
  // as well as `load`'s identity, because `load` is derived from the FOCUSED stored id — and the
  // two differ exactly when focus moves without changing the chat, or when the chat changes while
  // a tile is focused. Keyed on `load` alone, an active-chat change left the previous session's
  // context figure and high-water mark in place: the same context across sessions, and a total
  // pinned at the other session's value.
  useEffect(() => {
    live.current = 0
    liveAnchor.current = 0
    chars.current = 0
    chunks.current = 0
    best.current = 0
    aliasRef.current = null
    rowTotalRef.current = 0
    tickSeen.current = false
    // Paint what this session reported earlier in this app run instead of blanking: the pull below
    // then refreshes it. A session never seen before still starts empty, as it must. The totals
    // row rides the same rule — the read that follows can miss or fail for seconds, and the
    // zeros in between are the "everything resets to zero on a session switch" report.
    const remembered = memoFor()
    const rememberedRow = rowMemoFor()

    ctxRef.current = remembered
    setBase(rememberedRow)
    setCtx(remembered)
    setSubagents(null)
    setRowState('pending')
    void load()
  }, [identityKey, load])

  // The context window belongs to the model: on a switch the old limit must not
  // linger, so clear it (the row shows — for a moment) and re-read. The next usage
  // payload paints the new window; the poll alone would not, since the row carries
  // no context fields.
  const modelRef = useRef(model)
  useEffect(() => {
    if (modelRef.current === model) return

    modelRef.current = model
    setCtx(null)
    void refresh()
    void pullContext({ force: true })
  }, [model, refresh])

  // A session switch — or a resume, where the runtime id arrives just after the
  // switch — must re-ask, otherwise a panel showing the new session keeps the previous
  // session's "—". The pull is skipped when a push payload already painted the row.
  useEffect(() => {
    if (!runtimeId) return

    void pullContext()
  }, [pullContext, runtimeId, storedId])

  // The backend half is read ONCE per view mount, not per session: the summary is profile-wide, so
  // re-reading it every time the selected session changed was pure cost on the switch path (it is
  // the slowest request the pane makes). Opening the pane still gets its totals at once, and the
  // Overview's own loop keeps them fresh while it is open.
  useEffect(() => {
    void loadRecorded(restRef.current)
  }, [])

  // Turn end is when the row is written — pick it up, and stop polling while working.
  useEffect(() => {
    chars.current = 0
    void load()
    void pullContext()

    // One poll per window, for the same reason as one subscriber.
    OWNERS.poll += 1

    if (OWNERS.poll === 1) {
      ENGINE.timer = setInterval(() => {
        void load()
        void pullContext() // no-op unless the window is still unknown
      }, POLL_MS)
    }

    return () => {
      OWNERS.poll -= 1

      // Last view out stops the poll — and only then, wherever it was installed from.
      if (OWNERS.poll === 0 && ENGINE.timer) {
        clearInterval(ENGINE.timer)
        ENGINE.timer = 0
      }
    }
  }, [load])

  const baseTotal = base?.total ?? 0
  const subagentTokens = subagents?.tokens ?? 0
  const subagentCost = subagents?.cost ?? 0
  const grown = Math.max(0, live.current - liveAnchor.current)
  const streamed = Math.floor(chars.current / CHARS_PER_TOKEN)
  // The session's OWN live figure (the partition rows plus the in-flight call). The
  // monotonic guard is about this part: a stale row or an over-shooting estimate must
  // never make the displayed number fall back.
  const computed = baseTotal + grown + streamed

  // Never render a SMALLER number inside one session. Two legitimate paths can
  // compute a lower value than what is already on screen (a stale row arriving
  // from the 15s poll, or the chars÷4 estimate over-shooting before the tick
  // replaces it with the real count) — each produced a visible flicker as the
  // digits fell back and climbed again. The session switch resets this.
  if (computed > best.current) best.current = computed

  const total = best.current
  // The chip reports what the session actually cost to run, subagents included; the
  // panel splits the two so neither figure is a mystery.
  const chipTotal = total + subagentTokens
  // The number is the session total, so wait for the row: painting the live
  // process counter first would show a smaller, wrong figure.
  const ready = base !== null || rowState === 'unavailable'

  // "in" as Hermes defines it: everything on the prompt side — uncached input plus
  // both cache buckets (`CanonicalUsage.prompt_tokens`).
  const cachedInput = (base?.cacheRead ?? 0) + (base?.cacheWrite ?? 0)

  // LIVE COST. The recorded cost only moves when the row is written (turn end) or re-read (the
  // 15 s poll), so a turn in progress showed a flat figure while the tokens climbed. Estimate the
  // in-flight part at the row's own blended rate — its cost over its tokens — mark it with `~`,
  // and drop the marker the moment a read brings the recorded value: the estimate is a bridge to
  // the real number, never a replacement for it.
  //
  // The blended rate UNDERSTATES an output-heavy call (cache-read tokens cost a fraction of
  // generated ones, and the row carries no per-bucket cost), so the estimate lags rather than
  // overshoots, and each read corrects it.
  // `base.cost` is the recorded ESTIMATE — standard-rate even where the pin halves the invoice —
  // so the flex multiplier is applied HERE, at compute time: the backend half's multipliers can
  // land after the row read, and the figure must flip to the flex price when they do.
  const mainCost = pricedCost(base?.costId, base?.actualCost > 0 ? base.actualCost : (base?.cost ?? 0) * flexMult(base?.costId), base?.claudePlan)
  const liveTokens = grown + streamed
  const rate = isClaudeLane(model) ? 0 : (base && base.total > 0 && mainCost > 0 ? mainCost / base.total : 0)
  const costLive = rate > 0 && liveTokens > 0
  const costShown = costLive ? mainCost + liveTokens * rate + subagentCost : mainCost + subagentCost

  return {
    base,
    chipTotal,
    costLive,
    readRecorded: () => loadRecorded(restRef.current),
    readRows: () => void load(),
    overview,
    costShown,
    statsRuntime: runtimeId,
    // The ADOPTED stored id, not the atom's: the row read rewrites `storedRef` when it resolves the
    // session on screen (`if (row?.id && row.id !== storedRef.current) ...`), and the context stamp
    // is written from that same ref. Comparing one against the other meant a window measured for a
    // resumed or reattached session — the common case right after a restart, while the app's atoms
    // are still settling — was stamped with one id and tested against another, so the row showed
    // nothing. Stamp and check must read the same source.
    statsStored: storedRef.current,
    statsStoredAtom: storedId,
    ctx,
    grown,
    onPull: pullContext,
    onRefresh: refresh,
    ready,
    refreshing,
    rowState,
    streamed,
    streamPriced: !isClaudeLane(model),
    subagentCost,
    subagents,
    subagentTokens,
    total
  }
}

/**
 * The status-bar figure: the glance number, and — clicked — the detail box itself, so the
 * full view is reachable without opening the sidebar tab. The same panel also lives in the
 * pane (`MonitorPane`); both read their own instance of `useMonitor`.
 */
function Chip() {
  const vm = useMonitor()
  const { base, chipTotal, costLive, costShown, ready, streamed, subagentCost, subagentTokens } = vm

  // `costShown` is the recorded cost, or that cost plus the in-flight part at the row's blended
  // rate while a call is running (`costLive` marks the estimate).
  const costLabel = `${costLive ? '~' : ''}$${costShown.toFixed(4)}`
  const hitLabel = typeof base?.cacheHit === 'number' ? `${base.cacheHit.toFixed(2)}%` : ''

  const trigger = jsx('button', {
    'aria-label': 'Show the session monitor details',
    'data-slot': 'session-monitor-chip',
    title: 'Session monitor — the details',
    type: 'button',
    className:
      'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    children: [
      // Fixed-width estimate slot: the marker appearing and disappearing used
      // to change the chip's width and shove the neighbouring status items.
      jsx('span', {
        className: 'inline-block w-[0.5em] text-center',
        children: ready && streamed > 0 ? '~' : ''
      }),
      jsx('span', {
        children: ready
          ? // Reading order: how much, how well it cached, what it cost.
            `${fmt(chipTotal)} tok${hitLabel ? ' · ' + hitLabel : ''}${costLabel ? ' · ' + costLabel : ''}`
          : // Before any value exists: a placeholder, never a zero that climbs.
            '… tok'
      })
    ]
  })

  // Clicking the figure opens the details right here, so they are reachable without the
  // sidebar tab being open. The same view also lives in the pane (see the registration):
  // the two are independent instances of `useMonitor`, which is what lets either one be
  // closed or hidden without starving the other.
  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, { asChild: true, children: trigger }),
      jsx(PopoverContent, {
        align: 'end',
        // w-auto, NOT a pinned width: the popover variant ships `w-72` (288px) while the
        // panel sets its own — pinning it clipped the longest figures.
        className: 'w-auto border-(--ui-stroke-secondary) p-0',
        side: 'top',
        sideOffset: 6,
        children: jsx(TokenPanel, { stats: vm })
      })
    ]
  })
}

/** `2026-09-14` → `Sep 14 GMT+7`; anything unparseable renders as empty rather than NaN. */
const dayLabel = iso => {
  const date = shortDate(iso)

  return date ? `${date}${zoneLabel ? ` ${zoneLabel}` : ''}` : ''
}

/** `2026-09-14` → `Sep 14`; anything unparseable renders as empty rather than NaN. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = iso => {
  const parts = String(iso ?? '').split('-')
  const month = MONTHS[Number(parts[1]) - 1]

  return month && parts[2] ? `${month} ${Number(parts[2])}` : ''
}

/**
 * One bar per day, the tallest scaled to the full height, today's bar in full contrast. Pointing
 * at a bar reads that day out under the graph (date left, tokens right — the same label/figure
 * arrangement as every row above it) and lights the bar up, so the value is available without
 * hovering tooltips that would float over the pane. A day with no usage keeps a 2px stub: an
 * absent bar and a zero bar read very differently, and "nothing that day" is information.
 */
function DayChart({ days }) {
  const [pointed, setPointed] = useState(null)
  const last = days.length - 1
  const active = pointed !== null && days[pointed] ? days[pointed] : null
  const peak = days.reduce((max, day) => Math.max(max, n(day?.tokens)), 0)

  return jsxs('div', {
    'data-slot': 'session-monitor-days',
    className: 'flex flex-col gap-1.5',
    children: [
      jsx('div', {
        'data-slot': 'session-monitor-days-bars',
        className: 'flex h-9 items-end gap-px',
        // Leaving the strip clears the readout: `onMouseLeave` here fires only for a real exit,
        // not when the pointer moves between two bars.
        onMouseLeave: () => setPointed(null),
        children: days.map((day, index) => {
          const tokens = n(day?.tokens)
          const lit = index === pointed

          // The hover target is this whole COLUMN, not the painted bar inside it: a quiet day is
          // a 2px stub, and asking someone to land the pointer on that is asking them to miss.
          // The column also tints when pointed at, so even a stub gives visible feedback that it
          // is the thing being read out.
          return jsx('div', {
            className: cn('flex h-full flex-1 items-end', lit && 'bg-(--chrome-action-hover)'),
            key: day?.date ?? String(index),
            onMouseEnter: () => setPointed(index),
            children: jsx('div', {
              className: cn(
                'w-full rounded-[1px]',
                tokens <= 0
                  ? 'bg-(--ui-stroke-tertiary)'
                  : index === last || lit
                    ? 'bg-foreground'
                    : 'bg-(--ui-text-tertiary)'
              ),
              // ≥6% so a day with usage is never invisible next to the peak of a 24-day window.
              style: { height: tokens > 0 ? `${Math.max(6, Math.round((tokens / peak) * 100))}%` : '2px' }
            })
          })
        })
      }),
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2 text-[0.625rem] text-muted-foreground',
        children: [
          jsx('span', { children: dayLabel(active ? active.date : days[0]?.date) }),
          // Idle it states the window's ends; pointed at, it answers with that day's tokens. The
          // dates carry `UTC` because that is the boundary the bars are cut on — the same one a
          // provider's own activity page uses, which is what makes the two comparable.
          jsx('span', {
            className: active ? 'tabular-nums text-foreground' : '',
            children: active ? `${fmt(active.tokens)} tokens` : dayLabel(days[last]?.date)
          })
        ]
      })
    ]
  })
}

/**
 * The Overview tab: every session in the profile, totalled, climbing while any of them runs. Its
 * base is the page of session rows (the same read the focused view makes); what makes it live is
 * the per-session deltas the tick handler records for every running session.
 */
function OverviewPane() {
  const { overview, readRecorded, readRows, streamed, streamPriced } = useMonitor()
  // Its own read loop, independent of the engine's poll: whatever a view's lifecycle does to the
  // shared subscriptions, the Overview on screen keeps reading the rows and the backend half.
  const reads = useRef({ readRecorded, readRows })

  reads.current = { readRecorded, readRows }

  useEffect(() => {
    const timer = setInterval(() => {
      void reads.current.readRows?.()
      void reads.current.readRecorded?.()
    }, OVERVIEW_MS)

    return () => clearInterval(timer)
  }, [])
  const o = overview ?? { cost: 0, costLive: false, liveTokens: 0, pricedTokens: 0, requests: 0, sessions: 0, tokens: 0 }
  // The streamed text of the session in front of you is not in any row and not yet in a tick, so
  // it is added here: without it the totals move once per completed call, and with it they climb
  // word by word like the chip does. Both totals then read as the recorded figures the moment a
  // read brings them in — which is the confirmation, per row.
  const inFlight = streamed > 0
  const tokensShown = o.tokens + streamed
  // Priced tokens only: Claude-lane tokens are in o.tokens but never in o.cost.
  const rate = o.pricedTokens > 0 && o.cost > 0 ? o.cost / o.pricedTokens : 0
  // Streamed text of a Claude-lane session counts as tokens, never as cost.
  const costShown = o.cost + (streamPriced ? streamed * rate : 0)
  const estimating = o.costLive || inFlight
  const today = periodSnapshot(TODAY, streamed, streamPriced)
  const month = periodSnapshot(MONTH, streamed, streamPriced)
  const costOf = snapshot => `${snapshot.live ? '~' : ''}$${snapshot.cost.toFixed(4)}`
  // The headline cost is the providers' OWN figure once it has been reconciled. The local estimate
  // can only value tokens Hermes recorded, so it misses everything billed outside this database —
  // earlier DeepSeek platform usage, OpenRouter's per-call charges — and reads well under the
  // invoice. The estimate stays visible as the part attributed to sessions.
  const confirmed = ENRICHED.confirmed && n(ENRICHED.confirmed.total) > 0 ? ENRICHED.confirmed : null
  const confirmedNote = confirmed
    ? [
        `confirmed ${(confirmed.checked_at ?? '').slice(0, 10)}`,
        `$${costShown.toFixed(2)} attributed to sessions`,
        ...(confirmed.deepseek == null ? ['DeepSeek not yet added'] : [])
      ].join(' · ')
    : null
  // Three sections — counters, tokens, costs — each separated by a hairline, mirroring the
  // session panel's rule above its derived figures. Monthly sits between Daily and Total in
  // each section so the eye reads short period → long period left to right, top to bottom.
  const groups = [
    [
      ['Sessions counted', fmt(o.sessions)],
      ['Total requests', fmt(o.requests ?? 0)]
    ],
    [
      ['Daily tokens', `${today.live && inFlight ? '~' : ''}${fmt(today.tokens)}`],
      ['Monthly tokens', `${month.live && inFlight ? '~' : ''}${fmt(month.tokens)}`],
      ['Total tokens', `${estimating && inFlight ? '~' : ''}${fmt(tokensShown)}`]
    ],
    [
      ['Daily cost', costOf(today)],
      ['Monthly cost', costOf(month)],
      ['Total cost',
        confirmed ? `$${confirmed.total.toFixed(2)}` : `${estimating ? '~' : ''}$${costShown.toFixed(4)}`,
        confirmedNote]
    ]
  ]

  return jsxs('div', {
    'data-slot': 'session-monitor-overview',
    className: 'flex w-64 flex-col gap-3 p-3 text-[0.75rem]',
    children: [
      jsx('p', { className: 'font-medium text-foreground', children: 'Overview' }),
      ...groups.flatMap((rows, index) => [
        ...(index > 0 ? [jsx('div', { className: 'border-t border-border/50', key: `rule-${index}` })] : []),
        jsx('ul', {
          className: 'flex flex-col gap-1.5',
          key: `group-${index}`,
          children: rows.map(([label, value, note]) =>
            jsxs(
              'li',
              {
                key: label,
                className: note ? 'flex flex-col gap-0.5' : 'flex items-baseline justify-between gap-2',
                children: note
                  ? [
                      jsxs('span', {
                        className: 'flex items-baseline justify-between gap-2',
                        children: [
                          jsx('span', { className: 'truncate text-muted-foreground', children: label }),
                          jsx('span', { className: 'tabular-nums text-foreground', children: value })
                        ]
                      }),
                      jsx('span', { className: 'truncate text-muted-foreground/70', children: note })
                    ]
                  : [
                      jsx('span', { className: 'truncate text-muted-foreground', children: label }),
                      jsx('span', { className: 'tabular-nums text-foreground', children: value })
                    ]
              }
            )
          )
        })
      ]),
      // The chart closes the tab: a fourth section, ruled off like the others, present only when
      // the backend half has answered (without it there is no per-day series to draw).
      ...(o.days && o.days.length
        ? [jsx('div', { className: 'border-t border-border/50', key: 'rule-chart' }), jsx(DayChart, { days: o.days, key: 'chart' })]
        : [])
    ]
  })
}

/** The sidebar pane: the same figures in full, plus the two refresh doors. */
function MonitorPane() {
  return jsx(TokenPanel, { stats: useMonitor() })
}

/**
 * The click panel, built to match the built-in Context Usage popover: same
 * paddings, same `justify-between` rows with tabular-nums on the right (label
 * muted, figure full contrast), a hairline before the derived figures.
 */
function TokenPanel({ stats }) {

  const { base, ctx, costLive, costShown, grown, onPull, onRefresh, refreshing, rowState, statsRuntime, statsStored, statsStoredAtom, streamed, subagentCost, subagents, subagentTokens, total } = stats
  // Show a window only while its stamp matches the chat on screen; otherwise the row reads "—"
  // until THIS session reports its own — which is what keeps one session's window from appearing
  // under another session's name.
  const shownCtx =
    ctx &&
    ((ctx.forRuntime ?? null) === (statsRuntime ?? null) ||
      (Array.isArray(ctx.forStored) && ctx.forStored.some(id => id === statsStored || id === statsStoredAtom)))
      ? ctx
      : null

  const cachedInput = (base?.cacheRead ?? 0) + (base?.cacheWrite ?? 0)
  // The popover mounts on open (Radix), so this is "the user looked at the panel":
  // the moment to fetch the context window if nothing has pushed one yet. Declared
  // after the destructuring above — a dep array is evaluated during render, so
  // naming `onPull` earlier would sit in its temporal dead zone.
  const pulled = useRef(false)
  useEffect(() => {
    if (pulled.current) return

    pulled.current = true
    void onPull()
  }, [onPull])

  // This session's own cost, before the subagents are added to it.
  const mainCost = pricedCost(base?.costId, base?.actualCost > 0 ? base.actualCost : (base?.cost ?? 0) * flexMult(base?.costId), base?.claudePlan)
  const estimating = grown > 0 || streamed > 0

  /** One label/value row. */
  const row = (key, label, value, options = {}) =>
    jsxs('li', {
      className: 'flex items-baseline justify-between gap-2',
      children: [
        jsx('span', { className: 'truncate text-muted-foreground', children: label }),
        jsx('span', {
          className: cn('tabular-nums text-foreground', options.strong && 'font-medium'),
          children: value
        })
      ]
    }, key)

  return jsxs('div', {
    'data-slot': 'session-monitor-panel',
    // w-64 (256px): the widest row is a label plus an 11-digit figure ≈ 195px, so
    // 320px left a third of the box empty once the percentage column went away.
    className: 'flex w-64 flex-col gap-3 p-3 text-[0.75rem]',
    children: [
      jsxs('div', { className: 'flex items-center justify-between gap-2', children: [
        jsx('p', { className: 'font-medium text-foreground', children: 'Session monitor' }),
        // Refresh re-reads the stored row immediately (the poll is every POLL_MS).
        // `title` rather than the SDK's Tip: the app tooltip was removed from this
        // plugin on request and the smoke test fails if a Tip comes back.
        jsx(
          RefreshButton,
          {
            'aria-label': 'Refresh',
            className: cn(
              'text-muted-foreground hover:text-foreground',
              RefreshButton === 'button' && 'px-1 text-[0.6875rem] leading-none'
            ),
            disabled: refreshing,
            onClick: onRefresh,
            title: 'Refresh',
            ...(RefreshButton === 'button' ? { type: 'button' } : { size: 'icon-xs', variant: 'ghost' }),
            children: RefreshIcon
              ? jsx(RefreshIcon, { className: cn(refreshing && 'animate-spin') })
              : jsx('span', { className: cn(refreshing && 'opacity-50'), children: '↻' })
          },
          'refresh'
        )
      ]}),
      // Three peers that PARTITION the session total — the rows add up to the
      // Total line beneath them:
      //   cache hits (reads + writes) + cache misses (uncached input) + output
      // NOTE the hit row includes cache WRITES, which are misses being written —
      // they are priced as writes (above input) and only become hits on the next
      // call, so "hit" here means "served from / placed into the cache".
      // A stacked bar sat here once and a percentage column after it; both were
      // removed on request — at these proportions a bar is one solid colour and
      // the percentages restated the Total. The cache ratio lives in the
      // "Cache hit rate" line below the rule.
      // Context window, above the token rows: full digits (like the session
      // figures) and a single-fill bar whose width is the share of the window in
      // use. Placeholder row until a payload arrives, so the layout never jumps.
      jsxs('div', { className: 'flex flex-col gap-1.5', children: [
        jsxs('div', { key: 'context-row', className: 'flex items-baseline justify-between gap-2', children: [
          jsx('span', { className: 'truncate text-muted-foreground', children: 'Context' }),
          jsx('span', {
            className: 'tabular-nums text-foreground',
            children: shownCtx
              ? `${shownCtx.estimated ? '~' : ''}${fmt(shownCtx.used)}${shownCtx.max > 0 ? ` / ${fmt(shownCtx.max)} · ${Math.round(shownCtx.percent)}%` : ''}`
              : '—'
          })
        ]}),
        jsx('div', {
          key: 'context-bar',
          'data-slot': 'session-monitor-context-bar',
          className: cn(
            'flex h-1.5 overflow-hidden rounded-full',
            shownCtx ? 'bg-(--ui-stroke-tertiary)' : 'dither bg-(--ui-bg-elevated)'
          ),
          // Children stay INSIDE props: in the automatic runtime the third argument
          // of jsx/jsxs is the KEY, so passing an element there silently renders an
          // empty element (this bug shipped for one test run: the bar had no fill).
          children: shownCtx
            ? jsx('span', {
                key: 'context-fill',
                className: 'h-full min-w-px rounded-full bg-(--ui-text-tertiary)',
                style: { width: `${Math.max(0, Math.min(100, shownCtx.percent))}%` }
              })
            : null
        })
      ]}),
      jsxs('ul', { className: 'flex flex-col gap-1.5', children: [
        row('cached', 'Cache hit', fmt(cachedInput)),
        row('in', 'Cache miss', fmt(base?.in ?? 0)),
        row('out', 'Output', fmt(base?.out ?? 0)),
        // The total closes the block: the three rows above add up to it, so it
        // sits under them instead of in the header. `~` marks a figure that still
        // contains an estimate (streamed text, or growth not yet written to the
        // stored row).
        row('total', 'Total', `${estimating ? '~' : ''}${fmt(total)}`, { strong: true }),
        // Subagent sessions run under their own rows, so they sit OUTSIDE the partition
        // above: shown only when this session has spawned any.
        subagents && subagentTokens > 0
          ? row('subagents', 'Subagents', `${fmt(subagentTokens)} · $${subagentCost.toFixed(4)}`)
          : null
      ]}),
      // Derived metrics, deliberately below a hairline: Cache hit rate and Cost are
      // computed from the session, not measured token buckets.
      jsxs('div', {
        className: 'flex flex-col gap-1.5 border-t border-border/50 pt-2.5',
        children: [
          jsxs('div', { className: 'flex items-baseline justify-between gap-2 text-[0.6875rem]', children: [
            jsx('span', { className: 'text-muted-foreground', children: 'Cache hit rate' }),
            jsx('span', {
              className: 'tabular-nums text-foreground',
              children: typeof base?.cacheHit === 'number' ? `${base.cacheHit.toFixed(2)}%` : '—'
            })
          ]}),
          jsxs('div', { className: 'flex items-baseline justify-between gap-2 text-[0.6875rem]', children: [
            jsx('span', { className: 'text-muted-foreground', children: 'Cost' }),
            jsx('span', {
              className: 'tabular-nums text-foreground',
              children:
                `${costLive ? '~' : ''}$${costShown.toFixed(4)}`
            })
          ]})
        ]
      })
    ]
  })
}

/**
 * Local error boundary. A throw from a plugin contribution otherwise reaches the
 * app's ROOT boundary and blanks the entire interface (this happened twice while
 * this plugin was being developed — a one-line slip cost the whole window). With
 * this in place the worst case is a chip that reads "— tok", and the failure is
 * logged where it can be found.
 */
class ChipGuard extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error(`[session-monitor] chip render failed — contained: ${error?.message}`)
  }

  render() {
    return this.state.failed ? jsx('span', { children: '— tok' }) : this.props.children
  }
}

export default {
  id: ID,
  name: 'Session Monitor',
  description: 'Live per-session tokens, cost and cache-hit rate for the current session',
  register(ctx) {
    debug('loaded', { at: new Date().toISOString() })

    // The backend half's summary route, if it is installed and enabled (see the README): the
    // recorded totals over every session, which the app side cannot read for itself.
    restRef.current =
      typeof ctx.rest === 'function'
        ? path =>
            // The backend cannot know which timezone the user is in — this side can, so it says so.
            ctx.rest(`${path}?tz=${encodeURIComponent(PERIOD_TZ)}&offset=${PERIOD_OFFSET}`)
        : null
    // `data` (not `render`) so the bar's own right-click menu can list it: an item
    // with a `toggleLabel` gets a "Show in status bar" checkbox and a persisted
    // hide flag; a plain `render` contribution is always-on chrome with no toggle.
    // The chip wraps itself in ChipGuard — one bad render must never reach the
    // root boundary.
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 205,
      data: {
        // Contribution id: must stay unique in the bar and is what the persisted
        // hide flag is keyed on (renaming it resets that one toggle).
        id: 'session-monitor',
        toggleLabel: 'Session monitor',
        render: () => jsx(ChipGuard, { children: jsx(Chip, {}) })
      }
    })
    ctx.register({
      id: 'overview',
      area: 'panes',
      title: 'Overview',
      // First tab of the same right-hand zone: what every session totals, live.
      data: {
        collapsible: true,
        hideOnly: true,
        placement: 'right',
        width: '260px'
      },
      render: () => jsx(ChipGuard, { children: jsx(OverviewPane, {}) })
    })
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Session monitor',
      // A tab beside SESSIONS in the left sidebar: the detail view lives where the
      // session list does, and the zone menu / command palette toggles it (hideOnly).
      data: {
        collapsible: true,
        hideOnly: true,
        // Its OWN zone on the right, deliberately NOT a tab in the sessions strip: docked there,
        // selecting our tab appeared to move the sessions pane's selection, and the readout
        // followed the selection to another session instead of describing the chat on screen.
        placement: 'right',
        width: '260px'
      },
      render: () => jsx(ChipGuard, { children: jsx(MonitorPane, {}) })
    })
  }
}
