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
 * PANEL — titled "Session monitor" with a refresh button (re-reads the stored row
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

function Chip() {
  const storedId = useValue(host.state.focusedStoredSessionId)
  const runtimeId = useValue(host.state.focusedSessionId)
  const profile = useValue(host.state.focusedSessionProfile)
  // The model decides the context WINDOW, so a switch has to invalidate it.
  const model = useValue(host.state.model)

  const [base, setBase] = useState(null) // stored row buckets
  // 'pending' until the row read settles. Without this the chip painted
  // base(null→0) + grown(live total) on mount — i.e. the PROCESS-local counter
  // (~45M) instead of the SESSION total (~92M) for the first ~100ms.
  const [rowState, setRowState] = useState('pending')
  // Context window of the focused session — `used / max` and the percentage.
  // Fed only from payloads already attributed to this session (see takeContext).
  const [ctx, setCtx] = useState(null)
  const ctxRef = useRef(null) // mirror with a stable read path for the pullers
  const [, repaint] = useState(0)

  const live = useRef(0) // completed-call counters for the focused runtime session
  const liveAnchor = useRef(0) // counter value the current base row already includes
  const rowTotalRef = useRef(0) // stored total at the last read — detects a row advance
  const tickSeen = useRef(false) // has this plugin lifetime seen the counter's baseline yet
  const chars = useRef(0) // characters streamed since the last accounted call
  const chunks = useRef(0) // chunks since the last accounted call
  const lastChunkAt = useRef(0) // arrival time of the previous chunk
  const best = useRef(0) // highest total rendered this session (monotonic guard)
  const frame = useRef(0)
  const storedRef = useRef(storedId)
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

  // Context fields ride on the same usage payloads as the token totals. The
  // callers check attribution first — the usage event by its runtime id, session
  // info by its stored id — so what lands here is always THIS session's window.
  // Declared ABOVE the events effect: that effect's dependency array is evaluated
  // during render, so a later `const` would sit in its temporal dead zone.
  const takeContext = useCallback(usage => {
    if (!usage) return

    const used = n(usage.context_used)
    const max = n(usage.context_max)

    if (used > 0 || max > 0) {
      const next = { estimated: Boolean(usage.context_estimated), max, percent: n(usage.context_percent), used }

      ctxRef.current = next
      setCtx(next)
    }
  }, [])

  useEffect(() => {
    if (typeof host.onEvent !== 'function') return undefined

    // STRICT ownership: an event belongs to this window's focused session only if
    // it carries that session's runtime id or its stored id. Both are per-window
    // focused identities, so this cannot admit another session's stream — the old
    // "accept unknown ids while the chat is busy" fallback is what let an idle
    // session's chip count this session's tokens. Verified live: the focused
    // runtime id DOES match its own usage/reasoning events (focusedRuntime
    // "0734c261" == sid "0734c261").
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
        if (!forFocused(event.session_id)) return

        const usage = event.payload?.usage
        const total = usage?.total

        takeContext(usage)

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
        if (event.payload?.stored_session_id !== storedRef.current) return

        // Same session, possibly a new runtime id (resume/reconnect): adopt it, so
        // the live ticks that follow are attributed instead of discarded.
        if (typeof event.session_id === 'string' && event.session_id) {
          aliasRef.current = event.session_id
        }

        takeContext(event.payload?.usage)
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
      if (!force && ctxRef.current !== null) return // pushed (measured) data beats an estimate
      if (typeof host.request !== 'function') return
      if (!runtimeId) return // a draft has no session to ask about

      try {
        const breakdown = await host.request('session.context_breakdown', { session_id: runtimeId })

        takeContext(breakdown)
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

    // Snapshot BEFORE the await so growth during the fetch is not lost.
    const liveNow = live.current

    try {
      const page = await host.listPersistedSessions(null, { limit: 500, profile })
      const row = (page?.sessions ?? []).find(candidate => matches(candidate, storedId))

      if (row) {
        const rowTotal = tokenCount(row)

        // The anchor — the counter value the stored row already includes — moves
        // ONLY when the row itself advances (a turn ended and was written). Moving
        // it on every read is what made a manual refresh (and the 15 s poll) discard
        // the live term the display was carrying: the number then sat still at its
        // previous value until new growth re-earned the discarded amount.
        if (rowTotal > rowTotalRef.current) liveAnchor.current = liveNow

        rowTotalRef.current = rowTotal

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
          total: rowTotal
        })
        return
      }

      setRowState('unavailable')
    } catch (error) {
      // A failed read must not touch the anchor either: the live term keeps the
      // tokens it has already counted.
      setRowState('unavailable')
    }
  }, [profile, storedId])

  // Manual refresh (declared AFTER `load`: its dependency array is evaluated during
  // render, so referencing a later `const` would be a temporal-dead-zone error).
  // Manual refresh for the panel's header button: re-read the stored row now
  // instead of waiting for the next poll. `refreshing` only drives the spinner.
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      await load()
      await pullContext({ force: true })
    } finally {
      setRefreshing(false)
    }
  }, [load, pullContext])


  // Session switch: every term belongs to the previous session.
  useEffect(() => {
    live.current = 0
    liveAnchor.current = 0
    chars.current = 0
    chunks.current = 0
    best.current = 0
    aliasRef.current = null
    liveAnchor.current = 0
    rowTotalRef.current = 0
    tickSeen.current = false
    ctxRef.current = null
    setBase(null)
    setCtx(null)
    setRowState('pending')
    void load()
  }, [load])

  // Same chat, new runtime session (resume after a backend restart): the agent's
  // counters restart at zero, so `total > live.current` would reject every new tick
  // and the live term would freeze. Re-anchor.
  useEffect(() => {
    live.current = 0
    liveAnchor.current = 0
    rowTotalRef.current = 0
    tickSeen.current = false
    chars.current = 0
    aliasRef.current = null
    ctxRef.current = null
    setCtx(null)
    void load()
  }, [load, runtimeId])

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

  // Turn end is when the row is written — pick it up, and stop polling while working.
  useEffect(() => {
    chars.current = 0
    void load()
    void pullContext()

    const timer = setInterval(() => {
      void load()
      void pullContext() // no-op unless the window is still unknown
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [load])

  const baseTotal = base?.total ?? 0
  const grown = Math.max(0, live.current - liveAnchor.current)
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
        // the panel sets its own — pinning the popover clipped the longest figures.
        // `cn` is tailwind-merge, so this overrides the variant's width.
        className: 'w-auto border-(--ui-stroke-secondary) p-0',
        side: 'top',
        sideOffset: 6,
        children: jsx(TokenPanel, {
          stats: { base, ctx, grown, onPull: pullContext, onRefresh: refresh, refreshing, rowState, streamed, total }
        })
      })
    ]
  })
}

/**
 * The click panel, built to match the built-in Context Usage popover: same
 * paddings, same `justify-between` rows with tabular-nums on the right (label
 * muted, figure full contrast), a hairline before the derived figures.
 */
function TokenPanel({ stats }) {

  const { base, ctx, grown, onPull, onRefresh, refreshing, rowState, streamed, total } = stats

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
      // Provenance appears ONLY in the degraded case. The ordinary
      // "N messages · this session's record" line was removed on request, but a
      // figure computed from live counters alone must still say so.
      rowState === 'unavailable'
        ? jsx('p', {
            className: 'text-[0.6875rem] text-muted-foreground',
            children: 'live only — no stored row for this session'
          })
        : null,
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
            children: ctx
              ? `${ctx.estimated ? '~' : ''}${fmt(ctx.used)}${ctx.max > 0 ? ` / ${fmt(ctx.max)} · ${Math.round(ctx.percent)}%` : ''}`
              : '—'
          })
        ]}),
        jsx('div', {
          key: 'context-bar',
          'data-slot': 'session-monitor-context-bar',
          className: cn(
            'flex h-1.5 overflow-hidden rounded-full',
            ctx ? 'bg-(--ui-stroke-tertiary)' : 'dither bg-(--ui-bg-elevated)'
          ),
          // Children stay INSIDE props: in the automatic runtime the third argument
          // of jsx/jsxs is the KEY, so passing an element there silently renders an
          // empty element (this bug shipped for one test run: the bar had no fill).
          children: ctx
            ? jsx('span', {
                key: 'context-fill',
                className: 'h-full min-w-px rounded-full bg-(--ui-text-tertiary)',
                style: { width: `${Math.max(0, Math.min(100, ctx.percent))}%` }
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
        row('total', 'Total', `${estimating ? '~' : ''}${fmt(total)}`, { strong: true })
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
                  ? `$${base.actualCost.toFixed(2)}`
                  : base?.cost > 0
                    ? `$${base.cost.toFixed(2)}`
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
    console.error(`[session-monitor] chip render failed — contained: ${error?.message}`)
  }

  render() {
    return this.state.failed ? jsx('span', { children: 'Σ — tok' }) : this.props.children
  }
}

export default {
  id: ID,
  name: 'Session Monitor',
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
        // Contribution id: must stay unique in the bar and is what the persisted
        // hide flag is keyed on (renaming it resets that one toggle).
        id: 'session-monitor',
        toggleLabel: 'Session monitor',
        render: () => jsx(ChipGuard, { children: jsx(Chip, {}) })
      }
    })
  }
}
