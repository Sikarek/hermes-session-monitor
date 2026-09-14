/**
 * Session Tokens — the focused session's cumulative token consumption, in the
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
 *    window's focused session (runtime id or stored id), minus the value captured
 *    when the base was read. The fused `host.state.focusedUsage` atom is NOT used:
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
 * PANEL — three rows that PARTITION the session total (Cache hit = cache read +
 * cache write, Cache miss = uncached input, Output = generation incl. reasoning),
 * then a hairline and two derived figures (cache hit rate, cost). Shares are all
 * of the session total, so they sum to 100%.
 *
 * WHAT IT READS — the complete surface, verifiable by reading this file:
 *   · host.state: focusedStoredSessionId, focusedSessionId, focusedSessionProfile
 *   · host.onEvent: session.usage, message.delta, reasoning.delta
 *   · host.listPersistedSessions(): the focused profile's session rows, refreshed
 *     every POLL_MS and at turn end
 * It never reads prompt or message content — streamed text is measured with
 * `.length` and dropped, only a character count is kept — never writes files or
 * storage, never touches config or credentials, and makes no network requests of
 * its own: every read goes through the app's own local backend.
 *
 * Plain ESM — loaded uncompiled, jsx() only. Imports limited to
 * @hermes/plugin-sdk + react.
 */

import { Component } from 'react'
import { cn, Popover, PopoverContent, PopoverTrigger, host, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ID = 'session-tokens'

/** Idle poll: catches writes this process did not make (cron, subagents, another window). */
const POLL_MS = 15_000
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
  console.error(`[session-tokens] ${label} ${JSON.stringify({ ...payload, t: Date.now() - BOOT })}`)
}

const tokenCount = row =>
  n(row?.input_tokens) + n(row?.output_tokens) + n(row?.cache_read_tokens) + n(row?.cache_write_tokens)

/** Rows carry the stored id; a compressed lineage also exposes resolved_id (the live tip). */
const matches = (row, storedId) =>
  Boolean(storedId) && (row?.id === storedId || row?.resolved_id === storedId)

function Chip() {
  const storedId = useValue(host.state.focusedStoredSessionId)
  const runtimeId = useValue(host.state.focusedSessionId)
  const profile = useValue(host.state.focusedSessionProfile)

  const [base, setBase] = useState(null) // stored row buckets
  // 'pending' until the row read settles. Without this the chip painted
  // base(null→0) + grown(live total) on mount — i.e. the PROCESS-local counter
  // (~45M) instead of the SESSION total (~92M) for the first ~100ms.
  const [rowState, setRowState] = useState('pending')
  const [, repaint] = useState(0)

  const live = useRef(0) // completed-call counters for the focused runtime session
  const liveAtFetch = useRef(0) // …at the moment the base was read
  const chars = useRef(0) // characters streamed since the last accounted call
  const chunks = useRef(0) // chunks since the last accounted call
  const lastChunkAt = useRef(0) // arrival time of the previous chunk
  const best = useRef(0) // highest total rendered this session (monotonic guard)
  const frame = useRef(0)
  const storedRef = useRef(storedId)
  const runtimeRef = useRef(runtimeId)
  // Events for one chat arrive under DIFFERENT ids depending on the emitter
  // (observed: usage/message.delta on one, thinking.delta/session.info on
  // another), so match an alias set rather than a single id.

  storedRef.current = storedId
  runtimeRef.current = runtimeId

  // Repaint on the next animation frame after a change: ≤16ms of latency, and
  // chunks arrive faster than any display can show. No tween — the rendered
  // number IS the computed total.
  const schedule = useCallback(() => {
    if (frame.current) return

    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      repaint(tick => tick + 1)
    })
  }, [])

  useEffect(() => () => frame.current && cancelAnimationFrame(frame.current), [])

  useEffect(() => {
    if (typeof host.onEvent !== 'function') return undefined

    // STRICT ownership: an event belongs to this window's focused session only if
    // it carries that session's runtime id or its stored id. Both are per-window
    // focused identities, so this cannot admit another session's stream — the old
    // "accept unknown ids while the chat is busy" fallback is what let an idle
    // session's chip count this session's tokens. Verified live: the focused
    // runtime id DOES match its own usage/reasoning events (focusedRuntime
    // "0734c261" == sid "0734c261").
    const forFocused = id => Boolean(id) && (id === runtimeRef.current || id === storedRef.current)

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
        if (!forFocused(event.session_id)) return

        const total = event.payload?.usage?.total

        if (typeof total === 'number' && total > live.current) onTick(total)
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

    return () => offs.forEach(off => off())
  }, [schedule])

  // Completed calls arrive as `session.usage` EVENTS, attributed strictly below.
  // The fused `host.state.focusedUsage` atom is deliberately NOT used: the app
  // merges rather than replaces that store, so a window whose session is idle can
  // inherit ANOTHER session's numbers — which is how one session's chip made an
  // idle session's chip climb.
  const onTick = useCallback(
    total => {
      const now = Date.now()
      const jump = total - live.current
      const since = now - lastTickAt.current

      // First tick after a (re)mount has no interval to measure against.
      if (jump > 0 && since > 0 && since < 60_000) rate.current = jump / since

      lastTickAt.current = now
      live.current = total
      chars.current = 0 // this call's text is inside `total` now
      schedule()
    },
    [schedule]
  )

  const load = useCallback(async () => {
    if (!storedId) {
      liveAtFetch.current = live.current
      setBase(null)
      setRowState('unavailable')
      return
    }

    // Snapshot BEFORE the await so growth during the fetch is not lost.
    const liveNow = live.current

    try {
      const page = await host.listPersistedSessions(null, { limit: 500, profile })
      const row = (page?.sessions ?? []).find(candidate => matches(candidate, storedId))

      liveAtFetch.current = liveNow

      if (row) {
        debug('row', { rowTotal: tokenCount(row), storedId })
        setRowState('ok')
        setBase({
          cacheRead: n(row.cache_read_tokens),
          cacheWrite: n(row.cache_write_tokens),
          in: n(row.input_tokens),
          // Cost as Hermes records it. NOTE: this is an ESTIMATE derived from the
          // model's published rates (cost_status 'estimated'); OpenRouter's own
          // per-generation charge is not persisted anywhere locally, so it cannot
          // be labelled as a bill.
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
          costSource: row.cost_source ?? '',
          costStatus: row.cost_status ?? '',
          actualCost: n(row.actual_cost_usd),
          out: n(row.output_tokens),
          total: tokenCount(row)
        })
        return
      }

      setRowState('unavailable')
    } catch (error) {
      liveAtFetch.current = liveNow
      setRowState('unavailable')
    }
  }, [profile, storedId])

  // Session switch: every term belongs to the previous session.
  useEffect(() => {
    live.current = 0
    liveAtFetch.current = 0
    chars.current = 0
    chunks.current = 0
    best.current = 0
    setBase(null)
    setRowState('pending')
    void load()
  }, [load])

  // Same chat, new runtime session (resume after a backend restart): the agent's
  // counters restart at zero, so `total > live.current` would reject every new tick
  // and the live term would freeze. Re-anchor.
  useEffect(() => {
    live.current = 0
    liveAtFetch.current = 0
    chars.current = 0
    void load()
  }, [load, runtimeId])

  // Turn end is when the row is written — pick it up, and stop polling while working.
  useEffect(() => {
    chars.current = 0
    void load()

    const timer = setInterval(() => void load(), POLL_MS)

    return () => clearInterval(timer)
  }, [load])

  const baseTotal = base?.total ?? 0
  const grown = Math.max(0, live.current - liveAtFetch.current)
  const streamed = Math.floor(chars.current / CHARS_PER_TOKEN)
  const computed = baseTotal + grown + streamed

  // Never render a SMALLER number inside one session. Two legitimate paths can
  // compute a lower value than what is already on screen (a stale row arriving
  // from the 15s poll, or the chars÷4 estimate over-shooting before the tick
  // replaces it with the real count) — each produced a visible flicker as the
  // digits fell back and climbed again. The session switch resets this.
  if (computed > best.current) best.current = computed

  const total = best.current
  // The number is the session total, so wait for the row: painting the live
  // process counter first would show a smaller, wrong figure.
  const ready = base !== null || rowState === 'unavailable'

  // "in" as Hermes defines it: everything on the prompt side — uncached input plus
  // both cache buckets (`CanonicalUsage.prompt_tokens`).
  const cachedInput = (base?.cacheRead ?? 0) + (base?.cacheWrite ?? 0)

  const costLabel = base?.cost > 0 ? `$${base.cost.toFixed(2)}` : ''
  const hitLabel = typeof base?.cacheHit === 'number' ? `${base.cacheHit.toFixed(2)}%` : ''

  const trigger = jsx('button', {
    type: 'button',
    className:
      'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) tabular-nums transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
    children: jsx('span', {
      className: 'inline-flex items-center',
      children: [
        jsx('span', { children: 'Σ' }),
        // Fixed-width estimate slot: the marker appearing and disappearing used
        // to change the chip's width and shove the neighbouring status items.
        jsx('span', {
          className: 'inline-block w-[0.5em] text-center',
          children: ready && streamed > 0 ? '~' : ''
        }),
        jsx('span', {
          children: ready
            ? `${fmt(total)} tok${costLabel ? ' · ' + costLabel : ''}${hitLabel ? ' · ' + hitLabel : ''}`
            : // Before any value exists: a placeholder, never a zero that climbs.
              '… tok'
        })
      ]
    })
  })

  return jsxs(Popover, {
    children: [
      // No hover tooltip: the click panel carries the detail, and the app's own
      // built-in items keep hover chrome minimal too.
      jsx(PopoverTrigger, { asChild: true, children: trigger }),
      jsx(PopoverContent, {
        align: 'end',
        // w-auto, NOT a pinned width: the popover variant ships `w-72` (288px) while
        // the panel is `w-80` (320px) — pinning the popover clipped the share column
        // and the longest figures. `cn` is tailwind-merge, so this overrides the
        // variant's width and lets the panel set it.
        className: 'w-auto border-(--ui-stroke-secondary) p-0',
        side: 'top',
        sideOffset: 6,
        children: jsx(TokenPanel, {
          stats: { base, grown, rowState, streamed, total }
        })
      })
    ]
  })
}

/**
 * The click panel, built to match the built-in Context Usage popover: same
 * paddings, same hairline-segment bar, same `justify-between` rows with
 * tabular-nums on the right.
 */
function TokenPanel({ stats }) {
  const { base, grown, rowState, streamed, total } = stats

  const cachedInput = (base?.cacheRead ?? 0) + (base?.cacheWrite ?? 0)
  const share = value => (total > 0 ? `${((value / total) * 100).toFixed(2)}%` : '—')
  // Children read as a share of their own group (In / Out), which is the natural
  // reading of an indented row — the group row carries the session-wide share.
  const pct = (value, parent) => (parent > 0 ? `${((value / parent) * 100).toFixed(1)}%` : '—')
  const estimating = grown > 0 || streamed > 0

  /** One label/value row; `indent` marks a bucket that belongs to the row above. */
  const row = (key, label, value, suffix, options = {}) =>
    jsxs('li', {
      className: cn('flex items-baseline justify-between gap-2', options.indent ? 'pl-3' : ''),
      children: [
        jsx('span', {
          className: cn('truncate', options.strong ? 'text-foreground' : 'text-muted-foreground'),
          children: label
        }),
        jsxs('span', {
          className: 'flex shrink-0 items-baseline gap-2',
          children: [
            jsx('span', {
              className: cn('tabular-nums', options.strong ? 'font-medium text-foreground' : 'text-foreground/90'),
              children: value
            }),
            // Fixed-width share column so the figures line up down the panel.
            jsx('span', { className: 'w-14 text-right tabular-nums text-muted-foreground', children: suffix ?? '' })
          ]
        })
      ]
    }, key)

  return jsxs('div', {
    'data-slot': 'session-tokens-panel',
    className: 'flex w-80 flex-col gap-3 p-3 text-[0.75rem]',
    children: [
      jsxs('div', { className: 'flex items-baseline justify-between gap-2', children: [
        jsx('p', { className: 'font-medium text-foreground', children: 'Session tokens' }),
        jsx('span', {
          className: 'tabular-nums text-[0.6875rem] text-muted-foreground',
          // `~` while any part of the number is an estimate (streamed text, or
          // growth not yet written to the stored row).
          children: `${estimating ? '~' : ''}${fmt(total)}`
        })
      ]}),
      // Provenance appears ONLY in the degraded case. The ordinary
      // "N messages · this session's record" line was removed on request, but a
      // figure computed from live counters alone must still say so.
      rowState === 'unavailable'
        ? jsx('p', {
            className: 'text-[0.6875rem] text-muted-foreground',
            children: 'live only — no stored row for this session'
          })
        : null,
      // Two groups: the prompt side (input + both cache buckets) and the output
      // side, each with its subtotal. The bar that used to sit here was one solid
      // segment at these proportions (cache read is ~99.6% of everything), so the
      // share column replaces it — a chart that shows one colour is not a chart.
      // Three peers that PARTITION the session total:
      //   cache hits (reads + writes) + cache misses (uncached input) + output
      // NOTE the hit row includes cache WRITES, which are misses being written —
      // they are priced as writes (above input) and only become hits on the next
      // call, so "hit" here means "served from / placed into the cache".
      // One denominator (the session total) for every row, so the shares add to
      // 100% and there is no untitled second scale to misread.
      jsxs('ul', { className: 'flex flex-col gap-1.5', children: [
        row('cached', 'Cache hit', fmt(cachedInput), share(cachedInput)),
        row('in', 'Cache miss', fmt(base?.in ?? 0), share(base?.in ?? 0)),
        row('out', 'Output', fmt(base?.out ?? 0), share(base?.out ?? 0))
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
                base?.actualCost > 0
                  ? `$${base.actualCost.toFixed(4)}`
                  : base?.cost > 0
                    ? `$${base.cost.toFixed(4)}`
                    : '—'
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
 * this in place the worst case is a chip that reads "Σ — tok", and the failure is
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
    console.error(`[session-tokens] chip render failed — contained: ${error?.message}`)
  }

  render() {
    return this.state.failed ? jsx('span', { children: 'Σ — tok' }) : this.props.children
  }
}

export default {
  id: ID,
  name: 'Session Tokens',
  description: 'Live per-session tokens, cost and cache-hit rate for the current session',
  register(ctx) {
    debug('loaded', { at: new Date().toISOString() })
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
        id: 'session-tokens',
        toggleLabel: 'Session tokens',
        render: () => jsx(ChipGuard, { children: jsx(Chip, {}) })
      }
    })
  }
}
