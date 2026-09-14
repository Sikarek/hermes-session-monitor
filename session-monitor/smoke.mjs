/**
 * Mount smoke test for this desktop plugin. Two phases:
 *
 *  1. MOUNT — the real plugin against a stub SDK, with jsdom + a real React root
 *     inside an error boundary. Fails on any render or effect error, and asserts
 *     the behavioural contract: synthetic `thinking.delta` / `message.delta`
 *     chunks must move the printed total by exactly chars ÷ 4.
 *
 *  2. CONTAINMENT — the same plugin with a DELIBERATE throw inside the chip. The
 *     app's root boundary must NOT fire and the chip must render its own fallback.
 *     A plugin throw that escapes reaches the root error boundary and blanks the
 *     whole window; that happened twice here, so it is now a test.
 *
 * Usage (any cwd):
 *   node ~/.hermes/desktop-plugins/session-monitor/smoke.mjs            # tests plugin.js in place
 *   SMOKE_TARGET=/tmp/staged.js node smoke.mjs                         # tests a staged copy
 *
 * Exit 0 = safe to install. Non-zero = do NOT let the app load it.
 */

import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = process.env.SMOKE_TARGET ? path.resolve(process.env.SMOKE_TARGET) : path.join(HERE, 'plugin.js')
const REPO = process.env.HERMES_REPO ?? path.join(os.homedir(), '.hermes', 'hermes-agent')
const code = fs.readFileSync(SRC, 'utf8')

const requireFromRepo = createRequire(path.join(REPO, 'package.json'))
const asImport = specifier => url.pathToFileURL(requireFromRepo.resolve(specifier)).href

const FATAL = /ReferenceError|TypeError|is not a function|is not defined|Cannot read|Maximum update depth/i

// ── stub SDK with exactly the names the plugin imports
// `[^}]*` (not `[\s\S]*?`): a lazy any-char match starts at the FIRST `import {`
// in the file and swallows every line up to the SDK one, which then generates a
// broken stub ("Missing initializer in const declaration").
const importMatch = code.match(/import\s*{([^}]*?)}\s*from\s*['"]@hermes\/plugin-sdk['"]/)

if (!importMatch) {
  console.error('FAIL: no @hermes/plugin-sdk import found — is this a desktop plugin?')
  process.exit(2)
}

const names = importMatch[1]
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean)

const KNOWN = ['atom', 'Button', 'cn', 'compactNumber', 'host', 'icons', 'Popover', 'PopoverContent', 'PopoverTrigger', 'Tip', 'usePluginI18n', 'useValue']

// The temp module must live INSIDE the repo so its bare `react` imports resolve.
const tmph = fs.mkdtempSync(path.join(REPO, '.st-smoke-'))

const stubFor = w => {
  // Values are interpolated as identifiers at GENERATION time. Anything left as
  // `${window.x}` would be evaluated later inside the generated module, where
  // `window` is the jsdom global (that bug produced a stub whose event map was
  // named "__stEvents_undefined", so every handler silently landed nowhere).
  const key = JSON.stringify(`__stEvents_${w.key}`)
  const runtime = JSON.stringify(w.runtime)
  const stored = JSON.stringify(w.stored)
  const cacheRead = String(w.cacheRead)
  const LIST_CALLS = JSON.stringify(`__stListCalls_${w.key}`)
  const SET_MODEL = JSON.stringify(`__stSetModel_${w.key}`)
  const SET_SESSION = JSON.stringify(`__stSetSession_${w.key}`)
  const SET_FOCUS = JSON.stringify(`__stSetFocus_${w.key}`)
  const cacheWrite = String(w.cacheWrite ?? 0)
  const ROW_EXTRA = JSON.stringify(`__stRowExtra_${w.key}`)
  const ADD_ROW_EXTRA = JSON.stringify(`__stAddRowExtra_${w.key}`)
  const BREAKDOWN = JSON.stringify(`__stBreakdown_${w.key}`)
  const BREAKDOWN_CALLS = JSON.stringify(`__stBreakdownCalls_${w.key}`)
  const BREAKDOWN_PARAMS = JSON.stringify(`__stBreakdownParams_${w.key}`)
  const BREAKDOWN_FAIL = JSON.stringify(`__stBreakdownFail_${w.key}`)
  const READ_THROWS = w.readThrows ? 'true' : 'false'
  const CHILD_ROWS = (w.children ?? [])
    .map(
      c => `,{
      id: ${JSON.stringify(c.id)}, parent_session_id: ${c.parent ? JSON.stringify(c.parent) : 'null'},
      input_tokens: ${c.in ?? 0}, output_tokens: ${c.out ?? 0},
      cache_read_tokens: ${c.cr ?? 0}, cache_write_tokens: ${c.cw ?? 0},
      estimated_cost_usd: ${c.cost ?? 0}, actual_cost_usd: ${c.actual ?? 0}, message_count: 1
    }`
    )
    .join('')
  const READ_ROWS = JSON.stringify(`__stReadRows_${w.key}`)
  const READ_DELAYS = JSON.stringify(`__stReadDelays_${w.key}`)
  const READ_CALLS = JSON.stringify(`__stReadCalls_${w.key}`)
  const LIST_READ = w.noRowMethod
    ? 'listPersistedSessions: undefined,'
    : `listPersistedSessions: async () => {
    const call = (globalThis[${READ_CALLS}] = (globalThis[${READ_CALLS}] ?? 0) + 1)

    ;(globalThis[${LIST_CALLS}] = (globalThis[${LIST_CALLS}] ?? 0) + 1)

    if (${READ_THROWS}) throw new Error('backend hiccup: sessions read failed')

    // Per-call fixtures: a test can hand back a different payload (and a different delay)
    // per read, which is how an out-of-order response is reproduced.
    const delays = globalThis[${READ_DELAYS}]
    const rows = globalThis[${READ_ROWS}]

    if (delays && delays[call - 1]) await new Promise(resolve => setTimeout(resolve, delays[call - 1]))
    if (rows && rows[call - 1]) return { limit: 1, offset: 0, sessions: rows[call - 1], total: rows[call - 1].length }

    return {
    limit: 1, offset: 0, total: 1,
    sessions: [{
      cache_read_tokens: ${cacheRead} + rowExtra, cache_write_tokens: ${cacheWrite}, cost_source: 'provider_models_api',
      cost_status: 'estimated', estimated_cost_usd: 1.3718, id: ${stored},
      input_tokens: 1000, message_count: 7, output_tokens: 500, reasoning_tokens: 100,
      resolved_id: ${runtime}
    }${CHILD_ROWS}]
    }
  },`
  const tail = names.filter(name => !KNOWN.includes(name)).map(name => `export const ${name} = noop`).join('\n')

  return `
const atomImpl = value => {
  const listeners = new Set()

  return {
    get: () => value,
    set: next => {
      value = next
      listeners.forEach(listener => listener(value))
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
const atom = atomImpl
const modelAtom = atom(${JSON.stringify('deepseek/deepseek-v4.1-flash')})
const storedAtom = atom(${stored})
const runtimeAtom = atom(${runtime})
const activeAtom = atom(${runtime}) // the chat on screen; the monitor follows this one
let rowExtra = 0
globalThis[${ADD_ROW_EXTRA}] = extra => {
  rowExtra = extra
}
const noop = () => null
const HANDLERS = {}
const EVENTS = (globalThis[${key}] = {})

export const host = {
  state: {
    activeSessionId: activeAtom,
    busy: atom(false),
    focusedSessionId: runtimeAtom,
    focusedSessionProfile: atom('default'),
    focusedStoredSessionId: storedAtom,
    focusedUsage: atom(null),
    gateway: atom('open'),
    model: modelAtom
  },
  notify: () => 'toast', notifyError: () => 'toast', navigate: () => {},
  revealPane: id => {
    ;(globalThis.__stRevealed ??= []).push(id)
  },
  // MANY handlers per event, like the app: the built-in status items and every view
  // of this plugin share these streams. Storing one handler per type made the newest
  // subscriber steal the events from the older one — the chip went deaf as soon as
  // the sidebar pane mounted. EVENTS[type] stays a callable so tests fire normally.
  onEvent: (type, handler) => {
    const handlers = (HANDLERS[type] = HANDLERS[type] ?? [])

    handlers.push(handler)
    EVENTS[type] = payload => handlers.slice().forEach(fn => fn(payload))

    return () => {
      const at = handlers.indexOf(handler)

      if (at >= 0) handlers.splice(at, 1)
    }
  },
  request: async (method, params) => {
    if (method === 'session.context_breakdown') {
      globalThis[${BREAKDOWN_CALLS}] = (globalThis[${BREAKDOWN_CALLS}] ?? 0) + 1
      globalThis[${BREAKDOWN_PARAMS}] = params

      // The backend rejects a runtime id it no longer holds (a detached or reaped
      // session); a test flips this to reproduce that.
      if (globalThis[${BREAKDOWN_FAIL}]) throw new Error('gateway: session not in memory')

      // A backend with nothing measured yet answers zeros; the test windows that
      // want a painted row set their own breakdown object.
      return globalThis[${BREAKDOWN}] ?? { categories: [], context_estimated: false, context_max: 0, context_percent: 0, context_used: 0 }
    }
    if (method === 'session.history') {
      // 3 assistant messages (300 chars of prose) + 2 tool calls (100 chars of args)
      return { count: 5, messages: [
        { role: 'assistant', text: 'x'.repeat(100) },
        { role: 'tool', name: 'terminal', args: { cmd: 'y'.repeat(45) } },
        { role: 'assistant', text: 'x'.repeat(100) },
        { role: 'tool', name: 'read_file', args: { path: 'z'.repeat(33) } },
        { role: 'assistant', text: 'x'.repeat(100) }
      ] }
    }
    return {}
  },
  restartGateway: async () => {}, status: async () => ({}),
  logs: { tail: async () => [] },
  // Counted so the refresh-button contract can assert that a fresh read happened.
  ${LIST_READ}
}

// Subscribing hop, like the app's useStore: without it a mutated atom would never
// re-render the chip and every change-propagation contract would be untestable.
globalThis[${SET_MODEL}] = next => modelAtom.set(next)
// Clicking a session in the sidebar makes it the ACTIVE chat and the focused tile.
globalThis[${SET_SESSION}] = (storedId, runtimeId) => {
  storedAtom.set(storedId)
  runtimeAtom.set(runtimeId)
  activeAtom.set(runtimeId)
}
// Moving FOCUS only (clicking a tile, a project, another pane) — the active chat stays put.
globalThis[${SET_FOCUS}] = (storedId, runtimeId) => {
  storedAtom.set(storedId)
  runtimeAtom.set(runtimeId)
}
export const useValue = value => {
  if (!value || typeof value.get !== 'function') return value

  const [snapshot, setSnapshot] = useState(value.get())

  useEffect(() => {
    setSnapshot(value.get())

    return value.subscribe ? value.subscribe(setSnapshot) : undefined
  }, [value])

  return snapshot
}
export const usePluginI18n = () => (key, ...args) => [key, ...args].join(' ')
export const compactNumber = value => String(value ?? 0)
export const cn = (...args) => args.filter(Boolean).join(' ')
import { createElement, useEffect, useState } from 'react'
${w.noButton ? 'export const Button = undefined\nexport const icons = undefined' : `export const Button = ({ children, ...props }) => createElement('button', props, children)`}
export const Popover = ({ children, onOpenChange }) => {
  useEffect(() => { onOpenChange?.(true) }, [])
  return createElement('div', { 'data-stub': 'popover' }, children)
}
export const PopoverTrigger = ({ children }) => children
export const PopoverContent = ({ children, className }) =>
  createElement('div', { 'data-stub': 'popover-content', className }, children)
export const Tip = ({ children, label }) => {
  globalThis.__stTipLabels = globalThis.__stTipLabels ?? []
  globalThis.__stTipLabels.push(label)
  return children
}
${w.noButton ? '' : 'export const icons = new Proxy({}, { get: () => noop })'}
export { atom }
${tail}
`
}

const WINDOWS = {
  a: { cacheRead: 26428800, key: 'A', runtime: 'rtA', stored: 'storedA' },
  b: { cacheRead: 500000, key: 'B', runtime: 'rtB', stored: 'storedB' },
  // Edge fixtures — each one a situation from the field (see EDGE CASES below).
  c: { cacheRead: 1000, key: 'C', runtime: null, stored: null }, // a draft: no session yet
  d: { cacheRead: 1000, key: 'D', readThrows: true, runtime: 'rtD', stored: 'storedD' }, // backend hiccup
  e: { cacheRead: 1000, key: 'E', noRowMethod: true, runtime: 'rtE', stored: 'storedE' }, // older desktop build
  f: { cacheRead: 1000, cacheWrite: 500, key: 'F', runtime: 'rtF', stored: 'storedF' }, // provider that bills cache writes
  g: { cacheRead: 1000, key: 'G', noButton: true, runtime: 'rtG', stored: 'storedG' }, // older SDK: no Button/icons
  h: { cacheRead: 10000, key: 'H', runtime: 'rtH', stored: 'storedH' }, // refresh/anchor accounting
  i: { cacheRead: 5000, key: 'I', runtime: 'rtI', stored: 'storedI' }, // context pull: no push payloads
  j: { cacheRead: 20000, key: 'J', runtime: 'rtJ', stored: 'storedJ' }, // a plugin mounted mid-session
  k: { cacheRead: 30000, key: 'K', runtime: 'rtK', stored: 'storedK' }, // pull retry + session change
  m: { cacheRead: 2000, key: 'M', runtime: 'rtM', stored: 'storedM' }, // pane without the chip
  n: { cacheRead: 4000, key: 'N', runtime: 'rtN', stored: 'storedN' }, // out-of-order reads
  o: { cacheRead: 7000, key: 'O', runtime: 'rtO', stored: 'storedO' }, // focus vs active chat
  p: { cacheRead: 3000, key: 'P', runtime: 'rtP', stored: 'storedP' }, // the context figure's session stamp
  q: { cacheRead: 1000, key: 'Q', runtime: 'rtQ', stored: 'storedQ' }, // the backend half's recorded totals
  r: { cacheRead: 1500, key: 'R', runtime: 'rtR', stored: 'storedR' }, // view lifecycle
  l: {
    // subagents: two children (2,000 + 1,000 tokens), one grandchild (500), and an
    // unrelated session that must never be counted.
    cacheRead: 10000,
    children: [
      { cost: 0.05, cr: 800, id: 'childL1', in: 1000, out: 200, parent: 'storedL' },
      { actual: 0.02, cr: 400, id: 'childL2', in: 500, out: 100, parent: 'storedL' },
      { cr: 300, id: 'gcL1', in: 100, out: 100, parent: 'childL1' },
      { cost: 9.99, cr: 999000, id: 'otherL', in: 999, out: 0, parent: null }
    ],
    key: 'L',
    runtime: 'rtL',
    stored: 'storedL'
  } // subagent accounting
}

const stubPathFor = window => {
  const file = path.join(tmph, `sdk-stub-${window.key}.mjs`)

  fs.writeFileSync(file, stubFor(window))

  return file
}

const stubPath = stubPathFor(WINDOWS.a)

if (process.env.DUMP_STUB) {
  console.log(fs.readFileSync(stubPath, 'utf8'))
  process.exit(0)
}

const toModule = (source, file, stub = stubPath) => {
  const target = path.join(tmph, file)

  fs.writeFileSync(target, source.replace("'@hermes/plugin-sdk'", JSON.stringify(stub)))

  return target
}

// ── jsdom + React
const jsdomModule = await import(asImport('jsdom'))
const { JSDOM } = jsdomModule.JSDOM ? jsdomModule : jsdomModule.default
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })

// Node 22 ships a read-only global `navigator`, hence defineProperty over assignment.
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver']) {
  try {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key], writable: true })
  } catch {
    /* a global we cannot shadow is fine to skip */
  }
}

globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
globalThis.matchMedia =
  dom.window.matchMedia ?? (() => ({ addEventListener() {}, matches: false, removeEventListener() {} }))
globalThis.ResizeObserver = dom.window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }

const reactModule = await import(asImport('react'))
const React = reactModule.default ?? reactModule
const clientModule = await import(asImport('react-dom/client'))
const createRoot = clientModule.createRoot ?? clientModule.default?.createRoot

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Flatten a React element tree: text fragments + the number of <br> line breaks. */
function flatten(node, out = { brs: 0, strings: [] }) {
  if (node === null || node === undefined || node === false) return out

  if (Array.isArray(node)) {
    node.forEach(entry => flatten(entry, out))

    return out
  }

  if (typeof node === 'string' || typeof node === 'number') {
    out.strings.push(String(node))

    return out
  }

  if (typeof node === 'object' && node.props) {
    if (node.type === 'br') out.brs += 1
    flatten(node.props.children, out)
  }

  return out
}

/** Mount one module in a fresh container + boundary, return what happened. */
async function mount(modulePath) {
  const failures = []
  const chatter = []
  const originalError = console.error
  const rootEl = document.createElement('div')

  document.body.append(rootEl)

  console.error = (...args) => {
    const line = args.map(String).join(' ')

    chatter.push(line.split('\n')[0])

    if (FATAL.test(line)) failures.push(line.split('\n')[0])
  }

  let boundaryCaught = null

  class Boundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { failed: null }
    }

    static getDerivedStateFromError(error) {
      return { failed: error }
    }

    componentDidCatch(error) {
      boundaryCaught = error?.message ?? 'error'
      failures.push(`APP ROOT boundary caught: ${error?.message}`)
    }

    render() {
      return this.state.failed ? null : this.props.children
    }
  }

  const registered = []
  const ctx = {
    id: 'stub',
    register: contribution => {
      registered.push(contribution)

      return () => {}
    },
    registerMany: list => {
      list.forEach(c => registered.push(c))

      return () => {}
    },
    // A test may stand in for the backend half by setting globalThis.__stSummary.
    rest: async path => (path === 'summary' && globalThis.__stSummary ? globalThis.__stSummary : {}),
    socket: () => () => {},
    storage: { get: () => undefined, remove: () => {}, set: () => {} },
    os: { notify: () => {}, openExternal: () => {}, reveal: () => {} },
    i18n: { register: () => {} }
  }

  let nodes = []
  let rerender = null

  try {
    const plugin = (await import(modulePath)).default

    plugin.register(ctx)

    if (registered.length === 0) throw new Error('register() contributed nothing')

    const mountable = () =>
      (globalThis.__stPaneOnly ? registered.filter(c => c.area === 'panes') : registered)
        .map(contribution => (contribution.render ? contribution.render() : contribution.data?.render?.() ?? null))
        .filter(Boolean)

    nodes = mountable()

    const root = createRoot(rootEl)

    root.render(React.createElement(Boundary, null, nodes))
    // Re-render with a subset: this UNMOUNTS the omitted views for real, which is how a tab closing
    // or a hidden status-bar item behaves — the lifecycle bug this exists to catch (a view's unmount
    // tearing down the window's subscriptions while another view was still on screen).
    rerender = filter => {
      globalThis.__stPaneOnly = filter === 'panes'
      root.render(React.createElement(Boundary, null, mountable()))
    }
    await wait(450)
  } catch (error) {
    failures.push(`threw: ${error?.message}\n      ${(error?.stack ?? '').split('\n').slice(1, 4).join('\n      ')}`)
  }

  const markup = rootEl.textContent ?? ''

  console.error = originalError

  return { boundaryCaught, chatter, container: rootEl, failures, markup, nodes, registered, rerender }
}

// ── phase 1: the real plugin
const real = await mount(toModule(code, 'plugin.mjs'))
const stored = 1000 + 500 + WINDOWS.a.cacheRead + 0 // window A's stub row (input + output + cache_read + cache_write)

if (real.failures.length > 0 || real.boundaryCaught) {
  console.error('\nFAIL (mount) — this plugin would break the app:\n' + real.failures.map(f => `  • ${f}`).join('\n'))
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

if (!/tok/.test(real.markup)) {
  console.error(
    `FAIL (mount) — nothing rendered.\n  markup: "${real.markup.slice(0, 200)}"\n  failures: ${real.failures.length === 0 ? '(none captured)' : real.failures.join(' | ')}\n  console: ${real.chatter.slice(0, 3).join(' | ')}`
  )
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

// Behavioural contract: 160 synthetic stream chars ÷ 4 = 40 tokens on top.
const clearEvents = key => Object.keys(globalThis[key] ?? {}).forEach(k => delete globalThis[key][k])

clearEvents('__stEvents_A')

const fire = (type, text) => globalThis['__stEvents_A']?.[type]?.({ payload: { text }, session_id: WINDOWS.a.runtime, type })

// Re-mount to wire the handlers (the first mount's disposers ran with its root).
const live = await mount(toModule(code, 'plugin-live.mjs'))
const expected = (stored + 40).toLocaleString('en-US')

if (!live.failures.length) {
  try {
    for (const event of ['reasoning.delta', 'message.delta', 'session.usage', 'session.info']) {
      if (!globalThis['__stEvents_A']?.[event]) {
        throw new Error(`plugin did not subscribe to ${event}`)
      }
    }

    const container = document.body.lastElementChild
    const before = container.textContent ?? ''

    fire('reasoning.delta', 'x'.repeat(40))
    fire('reasoning.delta', 'x'.repeat(40))
    fire('message.delta', 'x'.repeat(80))

    await wait(250)

    const after = container.textContent ?? ''

    if (!after.includes(expected)) {
      throw new Error(`streamed chunks did not reach the total: expected "${expected}" in "${after.trim().slice(0, 90)}" (was "${before.trim().slice(0, 60)}")`)
    }

    // CHIP ORDER contract: how much · how well it cached · what it cost, no Σ prefix.
    const chipText = live.container.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? ''
    const at = { cost: chipText.indexOf('$'), hit: chipText.indexOf('%'), tok: chipText.indexOf(' tok') }

    if (chipText.includes('\u03a3')) throw new Error(`the Σ prefix is back on the chip: "${chipText}"`)
    if (!(at.tok > -1 && at.hit > at.tok && at.cost > at.hit)) {
      throw new Error(`chip reading order should be tokens · hit rate · cost — got "${chipText}"`)
    }

    // COMPLETED-CALL contract: `total` is the agent PROCESS's cumulative counter for
    // the session, so the first tick of a plugin lifetime is a BASELINE — the stored
    // row already contains most of a process cumulative, and claiming it as growth is
    // what made the chip show a wrong total until the next session switch.
    const baseline = 5000
    const grown = 9000

    globalThis['__stEvents_A']['session.usage']({
      payload: { usage: { total: baseline } },
      session_id: WINDOWS.a.runtime,
      type: 'session.usage'
    })
    await wait(250)

    const afterBaseline = container.textContent ?? ''

    if (afterBaseline.includes((stored + baseline).toLocaleString('en-US'))) {
      throw new Error(`the baseline tick was claimed as growth: "${afterBaseline.trim().slice(0, 60)}"`)
    }

    globalThis['__stEvents_A']['session.usage']({
      payload: { usage: { total: grown } },
      session_id: WINDOWS.a.runtime,
      type: 'session.usage'
    })
    await wait(250)

    const afterGrowth = container.textContent ?? ''
    const expectedGrowth = (stored + (grown - baseline)).toLocaleString('en-US')

    if (!afterGrowth.includes(expectedGrowth)) {
      throw new Error(`growth after the baseline was not counted: expected ${expectedGrowth} in "${afterGrowth.trim().slice(0, 90)}"`)
    }

    // CONTEXT CONTRACT: the window paints from an attributed usage payload. The
    // session.info path (stored id) is what shows it before the next API call.
    globalThis['__stEvents_A']['session.info']({
      payload: {
        stored_session_id: WINDOWS.a.stored,
        usage: { context_estimated: false, context_max: 200000, context_percent: 21, context_used: 41200 }
      },
      session_id: WINDOWS.a.runtime,
      type: 'session.info'
    })
    await wait(250)

    const afterContext = document.body.textContent ?? ''

    if (!afterContext.includes('41,200 / 200,000 · 21%')) {
      throw new Error(`context row not painted: "${afterContext.trim().slice(0, 120)}"`)
    }

    const fill = document.querySelector('[data-slot="session-monitor-context-bar"] span')

    if (fill?.style?.width !== '21%') {
      throw new Error(`context bar width wrong: got "${fill?.style?.width ?? 'no fill'}" for 21%`)
    }

    // A foreign session.info must not paint its window here (stored id decides).
    globalThis['__stEvents_A']['session.info']({
      payload: { stored_session_id: 'storedZ', usage: { context_max: 1000, context_percent: 99, context_used: 999 } },
      session_id: 'rtZ',
      type: 'session.info'
    })
    await wait(150)

    if ((document.body.textContent ?? '').includes('999 / 1,000')) {
      throw new Error('a foreign session.info painted its context window')
    }

    // REFRESH CONTRACT: the panel header carries a refresh button, and pressing it
    // re-reads the stored session row immediately instead of waiting for the poll.
    // Self-contained lookup: this block runs before `panelEl` is declared below.
    const refreshPanel = live.container.querySelector('[data-slot="session-monitor-panel"]')
    const refreshBtn = refreshPanel?.querySelector('button')
    const beforeCalls = globalThis.__stListCalls_A ?? 0

    if (!refreshBtn) throw new Error('the panel header has no refresh button')
    if (!(refreshBtn.getAttribute('aria-label') === 'Refresh')) {
      throw new Error(`the header button is not labelled as refresh ("${refreshBtn.getAttribute('aria-label')}")`)
    }

    refreshBtn.click()
    await wait(400)

    const afterCalls = globalThis.__stListCalls_A ?? 0

    if (afterCalls <= beforeCalls) {
      throw new Error(`refresh did not re-read the stored row (reads ${beforeCalls} → ${afterCalls})`)
    }

    // The title stays first in the header, the button second.
    const header = refreshPanel?.querySelector('div')
    const headerText = header?.textContent ?? ''

    if (!headerText.startsWith('Session monitor')) {
      throw new Error(`the header is not title-then-button: "${headerText.slice(0, 60)}"`)
    }

    // RESUME CONTRACT: a resumed session runs under a NEW runtime id while this
    // window may still hold the previous one. Its own session.info teaches the chip
    // that id, so the ticks that follow are adopted instead of discarded — the bug
    // behind "it only updates after I switch tabs and back".
    const numOf = text => Number((text.match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
    const beforeResume = container.textContent ?? ''
    const resumedRuntime = 'rtA-resumed'

    globalThis['__stEvents_A']['session.info']({
      payload: { stored_session_id: WINDOWS.a.stored, usage: { context_max: 200000, context_percent: 42, context_used: 84000 } },
      session_id: resumedRuntime,
      type: 'session.info'
    })
    await wait(150)
    globalThis['__stEvents_A']['session.usage']({
      payload: { usage: { total: 13000 } },
      session_id: resumedRuntime,
      type: 'session.usage'
    })
    await wait(250)

    const afterResume = container.textContent ?? ''

    if (!(numOf(afterResume) > numOf(beforeResume))) {
      throw new Error(`a tick from the resumed runtime id was rejected: "${beforeResume.trim().slice(0, 40)}" → "${afterResume.trim().slice(0, 40)}"`)
    }

    // MODEL CONTRACT: the window belongs to the model. A switch clears the stale
    // limit (the row shows —) and triggers a fresh read; leaving the previous
    // model's window on screen would misreport how full the context is.
    const readsBeforeModel = globalThis.__stListCalls_A ?? 0

    globalThis.__stSetModel_A?.('anthropic/claude-sonnet-5')
    await wait(300)

    const panelAfterModel = document.querySelector('[data-slot="session-monitor-panel"]')?.textContent ?? ''

    if (!panelAfterModel.includes('Context—')) {
      throw new Error(`a model switch left the old context window on screen: "${panelAfterModel.slice(0, 80)}"`)
    }

    if ((globalThis.__stListCalls_A ?? 0) <= readsBeforeModel) {
      throw new Error('a model switch did not trigger a fresh read of the stored row')
    }

    // The hover tooltip was removed on request (the click panel carries the
    // detail). Guard it: if a Tip ever returns, this fails.
    const tipLabels = globalThis.__stTipLabels ?? []

    if (tipLabels.some(label => label !== null && label !== undefined)) {
      throw new Error('a hover tooltip is registered again — it was removed on purpose')
    }

    // The click panel: same numbers, panel layout. Assert its rows exist in the
    // contribution's element tree (the popover only mounts on click).
    // The stub Popovers render their children, so the panel is in the DOM.
    // Scope to THIS window: several mounts live in the document (the guarded copy and
    // the isolation windows), so a document-wide lookup reads someone else's pane —
    // the containment copy's, which never receives events and shows "—".
    const thisPanel = live.container.querySelector('[data-slot="session-monitor-panel"]')
    const panel = thisPanel?.textContent ?? ''

    for (const needle of ['Session monitor', 'Context', 'Cache hit', 'Cache miss', 'Output', 'Total', 'Cache hit rate', 'Cost']) {
      if (!panel.includes(needle)) throw new Error(`panel is missing "${needle}" — got: ${panel.slice(0, 200)}`)
    }

    // ROW ORDER contract: the total sits UNDER the three rows it sums (it used to
    // ride in the header), and the title opens the panel.
    const iTitle = panel.indexOf('Session monitor')
    const iOut = panel.indexOf('Output')
    const iTotal = panel.indexOf('Total')

    if (!(iTitle < iOut && iOut < iTotal)) {
      throw new Error(`panel order wrong: title@${iTitle} Output@${iOut} Total@${iTotal}`)
    }

    // SURFACE CONTRACT: the detail view is a SIDEBAR PANE, not a popover — it used to
    // be a click popover on the chip, and moving it into the sessions column is the
    // whole point of the pane contribution. These assertions fail if the pane is
    // dropped or re-docked elsewhere, or if the panel is not where it belongs.
    const pane = (live.registered ?? []).find(c => c.id === 'pane')

    if (!pane) throw new Error('no sidebar pane was contributed — the detail view has nowhere to live')
    if (pane.title !== 'Session monitor') throw new Error(`pane title is "${pane.title}"`)
    // Its OWN zone, NOT the sessions strip: selecting a tab there appeared to move the sessions
    // pane's selection, and the readout followed the selection to another session. This assertion
    // is what keeps the pane out of that strip.
    if (pane.data?.placement !== 'right') throw new Error(`pane placement is "${pane.data?.placement}", expected its own zone on the right`)
    if (pane.data?.dock) throw new Error(`the pane is docked into "${pane.data.dock.pane}" — it must not share the sessions strip`)
    // TWO DOORS contract: the details are reachable BOTH ways — a popover on the
    // status-bar figure (the previous release's behaviour, for when the sidebar tab is
    // not open) and the pane beside SESSIONS. Neither replaces the other, and each is an
    // independent instance of the monitor, so one being closed cannot starve the other.
    const overviewPane = (live.registered ?? []).find(c => c.id === 'overview')

    if (!overviewPane || overviewPane.title !== 'Overview') {
      throw new Error('the Overview pane is missing from the sidebar')
    }

    if (!live.container.querySelector('[data-slot="session-monitor-overview"]')) {
      throw new Error('the Overview pane did not render')
    }

    const panels = [...live.container.querySelectorAll('[data-slot="session-monitor-panel"]')]

    if (panels.length !== 2) {
      throw new Error(`expected two detail views (the chip's popover and the sidebar pane), found ${panels.length}`)
    }

    const popover = live.container.querySelector('[data-stub="popover-content"]')

    if (!popover) throw new Error('clicking the figure would show nothing: no popover is contributed')
    if (!popover.querySelector('[data-slot="session-monitor-panel"]')) {
      throw new Error("the chip's popover does not render the panel")
    }

    const chipBtn = live.container.querySelector('[data-slot="session-monitor-chip"]')

    if (!chipBtn || chipBtn.tagName !== 'BUTTON') {
      throw new Error(`the figure must be the popover's trigger — got ${chipBtn ? chipBtn.tagName : 'nothing'}`)
    }

    // The two instances must agree: same sources, same arithmetic, no drift.
    const panelTotals = panels.map(el => (el.textContent ?? '').match(/Total~?([\d,]+)/)?.[1] ?? '?')

    if (panelTotals[0] !== panelTotals[1]) {
      throw new Error(`the popover and the pane disagree: ${panelTotals.join(' vs ')}`)
    }

    if (!/w-64/.test(panels[0].className)) {
      throw new Error(`panel width class missing ("${panels[0].className}")`)
    }

    // The assertions below read the pane (the persistent view): panels[0] is the
    // popover's, panels[1] the sidebar pane's.
    const panelEl = panels[1]

    // PRECISION contract: every cost is printed with four decimals, in the panel and in
    // the chip (a 2-decimal figure reads like a rounded bill; four show the stored value).
    const panelCost = (panelEl.textContent ?? '').match(/Cost~?\$(\d+\.\d+)/)?.[1] ?? ''

    if (!/^\d+\.\d{4}$/.test(panelCost)) {
      throw new Error(`the panel's cost should carry four decimals — got "$${panelCost || 'nothing'}"`)
    }

    const chipCost = (live.container.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? '').match(/~?\$(\d+\.\d+)/)?.[1] ?? ''

    if (!/^\d+\.\d{4}$/.test(chipCost)) {
      throw new Error(`the chip's cost should carry four decimals — got "$${chipCost || 'nothing'}"`)
    }


    // CONTRAST CONTRACT: figures are highlighted, labels are quiet — the app's own
    // Context usage convention (label: muted, value: foreground). So every numeric
    // element must carry `text-foreground`, no label may, and the title is the only
    // non-numeric element allowed to.
    const vividEls = [...panelEl.querySelectorAll('*')].filter(el => el.classList.contains('text-foreground'))
    const vividText = vividEls.map(el => (el.textContent ?? '').trim())
    const stray = vividText.filter(text => text !== 'Session monitor' && text !== '—' && !/\d/.test(text))

    if (stray.length) {
      throw new Error(`highlighted text that is not a figure: ${stray.join(' | ').slice(0, 90)}`)
    }

    for (const label of ['Cache hit', 'Cache miss', 'Output', 'Total', 'Cache hit rate', 'Cost']) {
      if (vividText.includes(label)) throw new Error(`label must stay muted: "${label}"`)
    }

    const figures = vividText.filter(text => /\d/.test(text))

    if (figures.length < 6) {
      throw new Error(`expected every figure highlighted (3 rows + total + rate + cost), got ${figures.length}: ${vividText.join(' | ').slice(0, 90)}`)
    }

    const expectedTotalText = (WINDOWS.a.cacheRead + 1000 + 500).toLocaleString('en-US')

    // The row percentages were removed on request — the Total states the partition.
    // Scoped to the panel's `li` rows: a whole-body substring test false-positives
    // on the chip's hit rate ("100.00%" contains "0.00%").
    const rowText = [...panelEl.querySelectorAll('li')].map(el => (el.textContent ?? '').trim()).join(' | ')

    if (rowText.includes('%')) {
      throw new Error(`row percentage is back — it was removed on request: ${rowText.slice(0, 120)}`)
    }
    if (document.querySelector('[data-slot="session-monitor-bar"], [data-slot="session-tokens-bar"]')) {
      throw new Error('the segmented bar is back — it was removed on request')
    }
    if (panel.includes('Input (uncached)')) throw new Error("old flat label 'Input (uncached)' is back")

    const chipNow = document.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? ''
    const chipFigure = Number((chipNow.match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
    const panelTotal = Number((panel.match(/Total~?([\d,]+)/)?.[1] ?? '0').replaceAll(',', ''))

    if (!chipFigure || panelTotal !== chipFigure) {
      throw new Error(`the pane and the chip disagree: chip ${chipFigure.toLocaleString('en-US')} vs pane Total ${panelTotal.toLocaleString('en-US')}`)
    }

    // Cost figure shown bare (the provenance parenthetical was removed on request).
    // Cost is printed at 4 decimals, in the panel and in the chip. This window has no
    // subagents, so the panel's cost is the session row's own 1.3718 (window L covers the
    // combined figure below).
    // The recorded value or the live estimate of it (`~$1.37xx` while a call is in flight).
    if (!/Cost~?\$1\.37\d\d/.test(panel)) throw new Error(`panel cost missing — got: ${panel.slice(0, 200)}`)

    if (panel.includes('(estimated') || panel.includes('provider_models_api')) {
      throw new Error('the cost parenthetical is back — it was removed on purpose')
    }

    if (!/\$1\.37/.test(live.container.textContent ?? '')) {
      throw new Error('chip does not show the compact cost')
    }

    // Cache hit rate: same formula as the gateway (round(cache_read / prompt × 100)).
    const expectedHit =
      (Math.round((WINDOWS.a.cacheRead / (WINDOWS.a.cacheRead + 1000 + 0)) * 10000) / 100).toFixed(2) + '%'

    if (!panel.includes('Cache hit rate')) throw new Error('panel is missing the cache hit rate row')
    if (!panel.includes(expectedHit)) throw new Error(`panel cache hit missing ${expectedHit} — got: ${panel.slice(0, 220)}`)
    if (!(live.container.textContent ?? '').includes(expectedHit)) throw new Error('chip is missing the cache hit rate')
  } catch (error) {
    live.failures.push(error.message)
  }
}

if (live.failures.length > 0) {
  console.error('\nFAIL (behaviour) — streamed text does not reach the counter:\n' + live.failures.map(f => `  • ${f}`).join('\n'))
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

// ── phase 2: containment — a throw inside the chip must NOT reach the app root
const broken = code.replace('function Chip() {', "function Chip() {\n  throw new Error('smoke: deliberate render failure')")
const guarded = await mount(toModule(broken, 'plugin-broken.mjs'))

if (guarded.boundaryCaught) {
  console.error(`\nFAIL (containment) — a chip error escaped to the app root boundary: ${guarded.boundaryCaught}`)
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

if (!/—/.test(guarded.markup)) {
  console.error(`\nFAIL (containment) — the chip did not render its own fallback ("${guarded.markup.slice(0, 80)}")`)
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}


// ── phase 3: ISOLATION — two windows (two focused sessions) on ONE event stream
const windowA = await mount(toModule(code, 'plugin-winA.mjs', stubPathFor(WINDOWS.a)))
const windowB = await mount(toModule(code, 'plugin-winB.mjs', stubPathFor(WINDOWS.b)))
const eventsFor = key => globalThis[`__stEvents_${key}`]
const broadcast = (type, event) => ['A', 'B'].forEach(key => eventsFor(key)?.[type]?.(event))
const totalOf = (row, cacheRead) => row + cacheRead + 500 + 1000

const aRow = totalOf(0, WINDOWS.a.cacheRead) + 0 // 26,440,300
const bRow = totalOf(0, WINDOWS.b.cacheRead) + 0 // 501,500
const isolation = []

if (windowA.failures.length || windowB.failures.length || windowA.boundaryCaught || windowB.boundaryCaught) {
  isolation.push('a window failed to mount')
}

await wait(250)

// 1) A's session streams 200 chars (50 tokens). B must not move by one token.
broadcast('reasoning.delta', { payload: { text: 'x'.repeat(200) }, session_id: 'rtA', type: 'reasoning.delta' })
broadcast('message.delta', { payload: { text: 'x'.repeat(200) }, session_id: 'rtA', type: 'message.delta' })
await wait(250)

const aAfterText = windowA.container.textContent ?? ''
const bAfterText = windowB.container.textContent ?? ''
const aExpected = (aRow + 100).toLocaleString('en-US') // 200 ÷ 4, twice
const bOwn = bRow.toLocaleString('en-US')

if (!aAfterText.includes(aExpected)) isolation.push(`A did not count its own stream (expected ${aExpected})`)
if (aAfterText.includes(bOwn)) isolation.push("A displayed B's total")
if (!bAfterText.includes(bOwn)) isolation.push(`B lost its own total (${bOwn}) — got ${bAfterText.slice(0, 80)}`)
if (bAfterText.includes(aExpected) || bAfterText.includes((aRow).toLocaleString('en-US'))) {
  isolation.push("B counted A's streamed text — the cross-session leak")
}

// 2) a THIRD session's usage tick, broadcast to both: nobody may adopt it.
broadcast('session.usage', { payload: { usage: { total: 99999999 } }, session_id: 'rtZ', type: 'session.usage' })
await wait(250)

const refused = '99,999,999'

if ((windowA.container.textContent ?? '').includes(refused)) isolation.push('A adopted a foreign session.usage tick')
if ((windowB.container.textContent ?? '').includes(refused)) isolation.push('B adopted a foreign session.usage tick')

if (isolation.length) {
  console.error('\nFAIL (isolation) — sessions are not separated:\n' + isolation.map(item => `  • ${item}`).join('\n'))
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

// ── EDGE CASES ───────────────────────────────────────────────────────────────
// Every one of these is a real situation the chip meets in the field: a draft with
// no session yet, a failing session read, an older desktop build without the read at
// all, a provider that BILLS cache writes, a garbage payload, and a session switch
// inside one window. None may throw, paint NaN, or reach the app root boundary.
const edge = []
const edgeAssert = (name, ok, detail = '') => {
  if (!ok) edge.push(`${name} — ${detail}`)
}

// C — a draft: no session ids at all.
const winC = await mount(toModule(code, 'plugin-winC.mjs', stubPathFor(WINDOWS.c)))

edgeAssert('draft window mounts clean', winC.failures.length === 0 && !winC.boundaryCaught, winC.failures[0] ?? 'boundary hit')
// No "live only" note any more: a draft shows the placeholder and then its own figures, without a
// line of prose about the backend's state.
edgeAssert('draft window shows no degraded note', !/live only|no stored row/i.test(winC.container?.textContent ?? ''), (winC.container?.textContent ?? '').slice(0, 70))

// D — the session read throws (backend hiccup): the chip must keep counting live.
const winD = await mount(toModule(code, 'plugin-winD.mjs', stubPathFor(WINDOWS.d)))

globalThis['__stEvents_D']?.['message.delta']?.({ payload: { text: 'x'.repeat(400) }, session_id: WINDOWS.d.runtime, type: 'message.delta' })
await wait(250)

edgeAssert('failing read mounts clean', winD.failures.length === 0 && !winD.boundaryCaught, winD.failures[0] ?? 'boundary hit')
edgeAssert('failing read keeps live counting', /100/.test(winD.container?.textContent ?? ''), (winD.container?.textContent ?? '').slice(0, 70))

// E — an older build with no host.listPersistedSessions: mount must survive.
const winE = await mount(toModule(code, 'plugin-winE.mjs', stubPathFor(WINDOWS.e)))

edgeAssert('missing read method mounts clean', winE.failures.length === 0 && !winE.boundaryCaught, winE.failures[0] ?? 'boundary hit')
edgeAssert('missing read method shows no degraded note', !/live only|no stored row/i.test(winE.container?.textContent ?? ''), (winE.container?.textContent ?? '').slice(0, 70))

// F — a provider that writes cache: Cache hit must be read + write, not read alone.
// The panel is looked up as the LAST one in the DOM (mount order), not by a loose
// document-wide regex — `501,500` in window B contains `1,500` and matched first
// when this assertion was written the lazy way.
const winF = await mount(toModule(code, 'plugin-winF.mjs', stubPathFor(WINDOWS.f)))
const panelF = [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)
const panelFText = panelF?.textContent ?? ''

edgeAssert('cache writes are counted in Cache hit', /1,500/.test(panelFText), `expected 1,000 read + 500 write in "${panelFText.slice(0, 90)}"`)
edgeAssert('the row total includes cache writes', /3,000/.test(panelFText), `expected the row total 3,000 in "${panelFText.slice(0, 90)}"`)

// G — an older SDK without `Button` or the icon set: the panel must still render a
// working refresh control instead of an invalid element type.
const winG = await mount(toModule(code, 'plugin-winG.mjs', stubPathFor(WINDOWS.g)))
const panelG = [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)

edgeAssert('missing Button/icons mounts clean', winG.failures.length === 0 && !winG.boundaryCaught, winG.failures[0] ?? 'boundary hit')
edgeAssert('missing Button/icons still shows a refresh control', Boolean(panelG?.querySelector('button')), 'no button rendered')
edgeAssert('the fallback glyph is used', /↻/.test(panelG?.textContent ?? ''), (panelG?.textContent ?? '').slice(0, 60))

// H — REFRESH ACCOUNTING (the reported bug): a manual refresh must not discard the
// live term, and a row advance must move the anchor without counting twice. The
// anchor — the counter value the stored row already includes — may only move when
// the row itself advances; moving it on every read is what froze the counter.
const winH = await mount(toModule(code, 'plugin-winH.mjs', stubPathFor(WINDOWS.h)))
const chipH = () => Number(((winH.container?.textContent ?? '').match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
const tickH = total =>
  globalThis['__stEvents_H']['session.usage']({
    payload: { usage: { total } },
    session_id: WINDOWS.h.runtime,
    type: 'session.usage'
  })
const rowH = 1000 + 500 + WINDOWS.h.cacheRead // input + output + cache_read (+ 0 write)

tickH(5000) // the baseline: the first tick of this plugin lifetime claims nothing
await wait(200)
edgeAssert('the baseline tick claims no growth', chipH() === rowH, `expected ${rowH.toLocaleString('en-US')}, got ${chipH().toLocaleString('en-US')}`)

tickH(9000)
await wait(250)
edgeAssert('growth after the baseline is counted', chipH() === rowH + 4000, `expected ${(rowH + 4000).toLocaleString('en-US')}, got ${chipH().toLocaleString('en-US')}`)

const beforeRefreshH = chipH()

;[...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1).querySelector('button')?.click()
await wait(400)

edgeAssert('a refresh does not move the total', chipH() === beforeRefreshH, `was ${beforeRefreshH.toLocaleString('en-US')}, now ${chipH().toLocaleString('en-US')}`)

tickH(12000)
await wait(250)

// LIVE COST: while a call is in flight the estimate must move with the tokens and be marked; the
// recorded value lands only when the row is re-read.
const costText = () => ((winH.container?.textContent ?? '').match(/~?\$[\d.]+/) ?? [''])[0]

edgeAssert('the live cost is marked as an estimate', costText().startsWith('~$'), `expected a "~$" figure, got "${costText()}"`)
edgeAssert('the live cost moves with the tokens', Number(costText().replace(/[~$]/g, '')) > 1.3718, `still flat at ${costText()}`)

edgeAssert(
  'counting continues after a refresh',
  chipH() === rowH + 7000,
  `expected ${(rowH + 7000).toLocaleString('en-US')}, got ${chipH().toLocaleString('en-US')} — the refresh discarded the live term`
)

// The turn ends and the row is written: the anchor moves, and the tokens already
// counted live must not be added a second time.
globalThis.__stAddRowExtra_H?.(7000)
;[...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1).querySelector('button')?.click()
await wait(400)

edgeAssert(
  'a row advance neither double-counts nor drops',
  chipH() === rowH + 7000,
  `expected ${(rowH + 7000).toLocaleString('en-US')}, got ${chipH().toLocaleString('en-US')}`
)

// With nothing in flight the figure is the recorded value, unmarked: that is the confirmation the
// estimate is only ever a bridge to it.
// CONFIRMATION: the row absorbed the live deltas when it was written, so the Overview shows the
// recorded totals unmarked — the estimate is only ever a bridge to them.
const overviewH = () => winH.container?.querySelector('[data-slot="session-monitor-overview"]')?.textContent ?? ''

edgeAssert(
  'the Overview confirms with the recorded total',
  overviewH().includes('18,500') && !/Total tokens~/.test(overviewH()),
  `expected the recorded total, unmarked: "${overviewH().slice(0, 110)}"`
)

edgeAssert(
  'the recorded value replaces the estimate when idle',
  !costText().startsWith('~$'),
  `expected the recorded figure while idle, got "${costText()}"`
)

tickH(15000)
await wait(250)

{
  const chipH = Number(((winH.container?.textContent ?? '').match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
  const paneH = Number((([...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)?.textContent ?? '').match(/Total~?([\d,]+)/)?.[1] ?? '0').replaceAll(',', ''))

  edgeAssert('the chip and the pane agree after a row advance', chipH === paneH, `chip ${chipH.toLocaleString('en-US')} vs pane ${paneH.toLocaleString('en-US')}`)
}

edgeAssert(
  'counting resumes from the new anchor',
  chipH() === rowH + 10000,
  `expected ${(rowH + 10000).toLocaleString('en-US')}, got ${chipH().toLocaleString('en-US')}`
)

// J — THE WRONG TOTAL (the second reported bug): a plugin mounted mid-session sees a
// process cumulative that the stored row ALREADY contains. Treating it as growth
// inflated the chip by everything this process had written — millions of tokens —
// until the next session switch reset the monotonic display.
const winJ = await mount(toModule(code, 'plugin-winJ.mjs', stubPathFor(WINDOWS.j)))
const chipJ = () => Number(((winJ.container?.textContent ?? '').match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
const tickJ = total =>
  globalThis['__stEvents_J']['session.usage']({
    payload: { usage: { total } },
    session_id: WINDOWS.j.runtime,
    type: 'session.usage'
  })
const rowJ = 1000 + 500 + WINDOWS.j.cacheRead

tickJ(5000000) // this process has already spent five million tokens on this session
await wait(250)
edgeAssert('a process cumulative does not inflate the total', chipJ() === rowJ, `expected ${rowJ.toLocaleString('en-US')}, got ${chipJ().toLocaleString('en-US')}`)

tickJ(5300000)
await wait(250)
edgeAssert('growth from that baseline is counted', chipJ() === rowJ + 300000, `expected ${(rowJ + 300000).toLocaleString('en-US')}, got ${chipJ().toLocaleString('en-US')}`)

// I — THE BLANK CONTEXT ROW (the reported bug): a panel opened on an idle session
// with nothing pushed yet must fetch the window on demand. The push payloads only
// flow during a turn, so relying on them alone left the row blank until the next
// call — and a refresh could not fix it, because the stored row carries no context.
globalThis.__stBreakdown_I = { categories: [], context_estimated: true, context_max: 1000000, context_percent: 42, context_used: 421888 }

const winI = await mount(toModule(code, 'plugin-winI.mjs', stubPathFor(WINDOWS.i)))
const chipI = winI.container?.textContent ?? ''
const panelI = [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)
const panelIText = panelI?.textContent ?? ''

edgeAssert('the context row is pulled on open', panelIText.includes('~421,888 / 1,000,000 · 42%'), `got "${panelIText.slice(0, 90)}"`)
edgeAssert('the pull used the breakdown RPC', (globalThis.__stBreakdownCalls_I ?? 0) > 0, 'no session.context_breakdown request was made')
edgeAssert('no push payload was needed', !chipI.includes('Context—'), 'the row was blank')

// A refresh re-pulls: the transcript moves on between turns, and the user asking to
// refresh expects the window to move with it.
globalThis.__stBreakdown_I = { categories: [], context_estimated: false, context_max: 1000000, context_percent: 51, context_used: 512000 }
panelI?.querySelector('button')?.click()
await wait(400)

const panelIRefreshed = [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)?.textContent ?? ''

edgeAssert('a refresh re-pulls the window', panelIRefreshed.includes('512,000 / 1,000,000 · 51%'), `got "${panelIRefreshed.slice(0, 90)}"`)

// K — A BLANK ROW THAT PERSISTS (the second report): the backend rejects a runtime id
// it no longer holds in memory, so a single fired-and-forgotten pull left the row blank
// through refreshes and tab switches. A rejected pull must be retried, and a session
// switch must re-ask for the new session instead of keeping the previous answer.
//
// NOTE two independent paths re-pull on a session change: an effect keyed on the
// window's ids, and the turn-end effect (its `load` identity changes with the session).
// Verified by removing both: this contract then fails with `asked for {"session_id":"rtK"}`.
// Keep at least one.
globalThis.__stBreakdownFail_K = true // the session is detached right now
globalThis.__stBreakdown_K = { categories: [], context_estimated: false, context_max: 500000, context_percent: 12, context_used: 60000 }

const winK = await mount(toModule(code, 'plugin-winK.mjs', stubPathFor(WINDOWS.k)))
const panelK = () => [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)?.textContent ?? ''

edgeAssert('a rejected pull leaves "—", not a wrong number', /Context—/.test(panelK()), `got "${panelK().slice(0, 80)}"`)

globalThis.__stBreakdownFail_K = false // the session comes back to life
await wait(2400) // the single retry has fired by now

edgeAssert('a rejected pull is retried', panelK().includes('60,000 / 500,000 · 12%'), `got "${panelK().slice(0, 90)}"`)

globalThis.__stBreakdown_K = { categories: [], context_estimated: false, context_max: 1000000, context_percent: 77, context_used: 770000 }
globalThis.__stSetSession_K?.('storedK2', 'rtK2')
await wait(600)

edgeAssert('a session switch re-pulls the window', panelK().includes('770,000 / 1,000,000 · 77%'), `got "${panelK().slice(0, 90)}"`)
edgeAssert('the re-pull asked for the NEW session id', globalThis.__stBreakdownParams_K?.session_id === 'rtK2', `asked for ${JSON.stringify(globalThis.__stBreakdownParams_K)}`)

// L — SUBAGENT ACCOUNTING: a session's subagents keep their own rows, so their tokens
// and cost are summed from the same page via `parent_session_id` (transitively — a
// subagent that spawned its own is still this session's). The chip reports the combined
// figure; the panel splits it. An unrelated session must never be counted.
const winL = await mount(toModule(code, 'plugin-winL.mjs', stubPathFor(WINDOWS.l)))
const chipL = winL.container?.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? ''
const panelL = () => [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)?.textContent ?? ''
const rowL = 1000 + 500 + WINDOWS.l.cacheRead // the session's own row: 11,500
const kidsL = 2000 + 1000 + 500 // two subagents + one grandchild: 3,500

edgeAssert('the chip counts the subagents', chipL.includes((rowL + kidsL).toLocaleString('en-US')), `expected ${(rowL + kidsL).toLocaleString('en-US')} in "${chipL.trim().slice(0, 60)}"`)
edgeAssert('the panel has a Subagents row', panelL().includes('Subagents3,500'), `got "${panelL().slice(0, 120)}"`)
edgeAssert('the Subagents row carries their cost', panelL().includes('$0.0700'), `got "${panelL().slice(0, 120)}"`)
edgeAssert('the chip cost is combined', chipL.includes('$1.4418'), `expected $1.4418 (1.3718 session + 0.07 subagents) in "${chipL.trim().slice(0, 60)}"`)
edgeAssert(
  'an unrelated session is not counted in the session view',
  !chipL.includes('999,999') && !panelL().includes('999,000') && !chipL.includes('$11.'),
  'a session with no parent link leaked into the FOCUSED session view (the Overview totals it by design)'
)
edgeAssert('the grandchild is counted', panelL().includes('Subagents3,500'), 'only direct children were summed')

// OVERVIEW TOTALS: every row in the page, plus the live deltas of running sessions. Window L's
// fixture has five rows — this session (11,500), two subagents (2,000 + 1,000), a grandchild (500)
// and an unrelated session (999,999) = 1,014,999. A tick from ANOTHER session must move the
// Overview and must NOT move the focused view.
const overviewL = () => winL.container?.querySelector('[data-slot="session-monitor-overview"]')?.textContent ?? ''

edgeAssert('the Overview totals every row', overviewL().includes('1,014,999'), `got "${overviewL().slice(0, 120)}"`)
edgeAssert('the in-flight row is gone', !/In flight now/.test(overviewL()), 'the "In flight now" row is back')
edgeAssert('the totals are labelled', /Total tokens/.test(overviewL()) && /Total cost/.test(overviewL()), `got "${overviewL().slice(0, 90)}"`)

// Requests are counted as observed, per session: two sessions, +4 and +3 calls = 7.
globalThis['__stEvents_L']['session.usage']({ payload: { usage: { calls: 5, total: 5000 } }, session_id: 'rtZ', type: 'session.usage' })
await wait(80)
globalThis['__stEvents_L']['session.usage']({ payload: { usage: { calls: 9, total: 9000 } }, session_id: 'rtZ', type: 'session.usage' })
await wait(80)
globalThis['__stEvents_L']['session.usage']({ payload: { usage: { calls: 3, total: 4000 } }, session_id: WINDOWS.l.runtime, type: 'session.usage' })
await wait(80)
globalThis['__stEvents_L']['session.usage']({ payload: { usage: { calls: 6, total: 7000 } }, session_id: WINDOWS.l.runtime, type: 'session.usage' })
await wait(200)

// 5 + 4 + 3 + 3: each session's first tick counts from zero (its own counter's origin), so the
// figure is every request those sessions have reported while the app has been watching.
edgeAssert('the Overview counts requests across sessions', /Total requests15/.test(overviewL()), `expected 15 requests, got "${overviewL().slice(0, 130)}"`)


await wait(150)
globalThis['__stEvents_L']['session.usage']({ payload: { usage: { total: 9000 } }, session_id: 'rtZ', type: 'session.usage' })
await wait(250)

// The absolute figure depends on the tick sequence above; the contract is that another session's
// activity MOVES the Overview while the focused view refuses it.
edgeAssert('the Overview counts another session running', !overviewL().includes('1,014,999'), `unchanged: "${overviewL().slice(0, 120)}"`)
edgeAssert(
  'the focused view still refuses that session',
  !(winL.container?.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? '').includes('1,018,999'),
  'another session moved the focused total'
)

// M — THE PANE WITHOUT THE CHIP: a status-bar item can be hidden from the bar's menu, so
// the pane must not depend on the chip's instance for its numbers. Each view runs its own
// (the details are a pane, the glance figure is a bar item) — this mounts the pane alone
// and requires it to adopt a live tick.
globalThis.__stPaneOnly = true

const winM = await mount(toModule(code, 'plugin-winM.mjs', stubPathFor(WINDOWS.m)))
const paneM = () => [...document.querySelectorAll('[data-slot="session-monitor-panel"]')].at(-1)?.textContent ?? ''
const rowM = 1000 + 500 + WINDOWS.m.cacheRead

globalThis.__stPaneOnly = false

globalThis['__stEvents_M']['session.usage']({ payload: { usage: { total: 5000 } }, session_id: WINDOWS.m.runtime, type: 'session.usage' })
await wait(200)
globalThis['__stEvents_M']['session.usage']({ payload: { usage: { total: 9000 } }, session_id: WINDOWS.m.runtime, type: 'session.usage' })
await wait(250)

edgeAssert(
  'the pane counts without the chip',
  paneM().includes(String(rowM + 4000)) || paneM().includes((rowM + 4000).toLocaleString('en-US')),
  `expected ${(rowM + 4000).toLocaleString('en-US')} in "${paneM().slice(0, 100)}"`
)

// N — OUT-OF-ORDER READS (the reported "refresh shows the wrong values"): reads are async,
// so a slow one issued first can land AFTER a newer one. Without a guard the old response
// painted its figures — another session's, or this session's stale row — into the current
// view and stayed there until the next read.
const ROW = (input, cost) => [{ cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: cost, id: WINDOWS.n.stored, input_tokens: input, message_count: 1, output_tokens: 0, resolved_id: WINDOWS.n.runtime }]

// Call 1 is the mount's own read (immediate); call 2 is the first refresh — SLOW, and
// carrying a stale, much larger figure; call 3 is the second refresh, immediate. The stale
// response therefore lands LAST, which is the out-of-order case that used to win.
const winN = await mount(toModule(code, 'plugin-winN.mjs', stubPathFor(WINDOWS.n)))
const chipN = () => winN.container?.textContent ?? ''
// Scoped to THIS window: the chip's popover panel comes first in the DOM, the pane's second.
// (A document-wide lookup in a harness with a dozen mounts can hit another window entirely.)
const panelsN = () => [...(winN.container?.querySelectorAll('[data-slot="session-monitor-panel"]') ?? [])]
const panePanelN = () => panelsN().at(-1)
const chipPanelN = () => panelsN()[0]
const refreshN = () => panelN()?.querySelector('button')?.click()

await wait(400) // both views' mount reads settle (each view reads on mount)

// Fixture for the two clicks only: every view reads on mount, so indexing by call number
// before that would land on the wrong read. Call 1 = the stale, slow response; call 2 = the
// fresh one — the stale response therefore arrives LAST.
globalThis.__stReadCalls_N = 0
globalThis.__stReadRows_N = [ROW(999999, 9.99), ROW(222, 0.02)]
globalThis.__stReadDelays_N = [600, 0]

// Two views, one read each: the pane's button issues the slow, stale read, the chip's
// popover button the fresh one. This is the real shape of the race — a read from one view
// racing a read from the other — and the guard has to be shared to catch it.
panePanelN()?.querySelector('button')?.click() // read 1: the pane's own instance, slow, stale
await wait(120)
chipPanelN()?.querySelector('button')?.click() // read 2: the chip's instance, immediate, fresh
await wait(900) // ...and read 1 arrives after it

edgeAssert(
  'a stale response is dropped',
  chipN().includes('222') && !chipN().includes('999,999'),
  `expected the newer read to stand — got "${chipN().trim().slice(0, 60)}"`
)
// O — ISOLATION ACROSS A SWITCH: once the chat changes, the previous session's events must not
// move the new one's figures. (The stub's session switch moves both ids, as a real click does.)
const winO = await mount(toModule(code, 'plugin-winO.mjs', stubPathFor(WINDOWS.o)))
const chipO = () => winO.container?.textContent ?? ''

await wait(300)

globalThis.__stSetSession_O?.('storedO2', 'rtO2')
await wait(400)

const beforeOverflow = chipO()

// The session that was on screen a moment ago keeps streaming: its tick and its words must be
// refused by the new session's view.
globalThis['__stEvents_O']['session.usage']({ payload: { usage: { total: 40000 } }, session_id: WINDOWS.o.runtime, type: 'session.usage' })
globalThis['__stEvents_O']['message.delta']({ payload: { text: 'x'.repeat(4000) }, session_id: WINDOWS.o.runtime, type: 'message.delta' })
await wait(350)

edgeAssert(
  'the previous session cannot move the current one',
  chipO() === beforeOverflow,
  `the counter took another session's events: "${beforeOverflow.trim().slice(0, 40)}" → "${chipO().trim().slice(0, 40)}"`
)

// ...while the session actually on screen still counts.
globalThis['__stEvents_O']['session.usage']({ payload: { usage: { total: 5000 } }, session_id: 'rtO2', type: 'session.usage' })
globalThis['__stEvents_O']['session.usage']({ payload: { usage: { total: 9000 } }, session_id: 'rtO2', type: 'session.usage' })
await wait(350)

edgeAssert(
  'the session on screen still counts',
  chipO() !== beforeOverflow,
  'the current session stopped counting'
)

// P — A CONTEXT FIGURE BELONGS TO A SESSION (the reported symptom): the window is the one value
// with no identity of its own, so it is stamped with the session it was measured for and shown
// only while that stamp matches the chat on screen. A payload carrying this session's STORED id
// but an older runtime id — a resume, or a relayed push — must not paint the current chat's row.
const winP = await mount(toModule(code, 'plugin-winP.mjs', stubPathFor(WINDOWS.p)))
const panelP = () => winP.container?.querySelector('[data-slot="session-monitor-panel"]')?.textContent ?? ''

await wait(300)

globalThis['__stEvents_P']['session.info']({
  payload: { stored_session_id: WINDOWS.p.stored, usage: { context_max: 500000, context_percent: 22, context_used: 111111 } },
  session_id: 'rtP-other',
  type: 'session.info'
})
await wait(250)

edgeAssert('a figure stamped for another runtime does not paint', !panelP().includes('111,111'), `leaked a stale window: "${panelP().slice(0, 90)}"`)

globalThis['__stEvents_P']['session.info']({
  payload: { stored_session_id: WINDOWS.p.stored, usage: { context_max: 500000, context_percent: 44, context_used: 222222 } },
  session_id: WINDOWS.p.runtime,
  type: 'session.info'
})
await wait(250)

edgeAssert('the figure for the current runtime paints', panelP().includes('222,222'), `got "${panelP().slice(0, 90)}"`)

// R — A VIEW CLOSING MUST NOT STOP THE WINDOW. The engine runs once per window; its handles belong
// to whoever is mounted last, not to whoever installed them. Unmounting a view (closing a pane tab,
// hiding the status-bar item) used to tear the subscriptions and the poll down while the other view
// was still on screen — that view then never moved again except on a session change, which is the
// "Overview only updates when I click a session" report.
const winR = await mount(toModule(code, 'plugin-winR.mjs', stubPathFor(WINDOWS.r)))
await wait(450)

// Take the CHIP away, leaving the panes: the Overview must keep counting.
winR.rerender?.('panes')
await wait(250)
globalThis['__stEvents_R']['session.usage']({ payload: { usage: { calls: 3, total: 7000 } }, session_id: WINDOWS.r.runtime, type: 'session.usage' })
await wait(300)

const overviewR = () => winR.container?.querySelector('[data-slot="session-monitor-overview"]')?.textContent ?? ''

// The tick reached the Overview at all — `Total requests 3` is its delta — which is the contract:
// with the chip gone, the panes' window kept its subscriptions. (Its token delta is zero on the
// first tick by design: the first sighting of a counter is a baseline, not growth.)
edgeAssert(
  'the Overview keeps counting after the chip unmounts',
  /Total requests3/.test(overviewR()),
  `got "${overviewR().slice(0, 130)}"`
)

// And the other way round: with the panes gone, the chip must still count.
winR.rerender?.('statusBar')
await wait(300)

// Two ticks: the first is the remounted view's baseline (the documented rule), the second is growth.
globalThis['__stEvents_R']['session.usage']({ payload: { usage: { total: 12000 } }, session_id: WINDOWS.r.runtime, type: 'session.usage' })
await wait(200)
globalThis['__stEvents_R']['session.usage']({ payload: { usage: { total: 16000 } }, session_id: WINDOWS.r.runtime, type: 'session.usage' })
await wait(300)

const chipR = winR.container?.querySelector('[data-slot="session-monitor-chip"]')?.textContent ?? ''

edgeAssert('the chip keeps counting after the panes unmount', /7,000|3,000 \+ 4,000/.test(chipR) || /6,999|7,001/.test(chipR), `got "${chipR.slice(0, 60)}"`)

// Q — THE RECORDED TOTALS (the backend half): with `/api/plugins/session-monitor/summary` answering,
// the Overview shows Hermes' own record over EVERY session — every provider, every model, tasks
// included — instead of the page of rows this side could read for itself. Without it, the page
// aggregate stands (window L above asserts that path).
globalThis.__stSummary = { totals: { calls: 24517, cost: 73.9135, sessions: 263, tokens: 5691612344 } }

const winQ = await mount(toModule(code, 'plugin-winQ.mjs', stubPathFor(WINDOWS.q)))
await wait(500)

const overviewQ = winQ.container?.querySelector('[data-slot="session-monitor-overview"]')?.textContent ?? ''

edgeAssert('the Overview shows the recorded totals', /5,691,612,344/.test(overviewQ) && /24,517/.test(overviewQ) && /263/.test(overviewQ), `got "${overviewQ.slice(0, 130)}"`)
edgeAssert('the recorded cost is shown', /\$73\.9135/.test(overviewQ), `got "${overviewQ.slice(0, 130)}"`)

globalThis.__stSummary = null

// A — garbage payloads: no NaN, no undefined, no Infinity anywhere on screen.
for (const payload of [undefined, null, {}, { usage: null }, { usage: { total: 'x' } }, { usage: { context_max: -5, context_percent: 'y', context_used: 'z' } }, { usage: { total: 1e15 } }]) {
  globalThis['__stEvents_A']['session.usage']({ payload, session_id: WINDOWS.a.runtime, type: 'session.usage' })
}
await wait(250)

const screenText = document.body.textContent ?? ''

edgeAssert('garbage payloads paint nothing invalid', !/NaN|undefined|Infinity/.test(screenText), (screenText.match(/NaN|undefined|Infinity/) ?? [''])[0])

// A — session switch inside ONE window: the new session's figures must take over,
// and the old runtime id must stop being accepted.
globalThis.__stSetSession_A?.('storedS2', 'rtS2')
await wait(300)

const chipAfterSwitch = () => Number(((windowA.container.textContent ?? '').match(/[\d,]+/)?.[0] ?? '0').replaceAll(',', ''))
const tickNew = total =>
  globalThis['__stEvents_A']['session.usage']({ payload: { usage: { total } }, session_id: 'rtS2', type: 'session.usage' })

tickNew(4200) // the new session's first tick: its baseline (see the accounting contract)
await wait(200)
tickNew(5200) // growth of 1,000 on top of it
await wait(250)

// This fixture has no stored row for the new session, so the total is the live growth
// alone — which is exactly what proves the switch re-anchored rather than kept counting
// the previous session.
edgeAssert('the new session is adopted after a switch', chipAfterSwitch() === 1000, `expected 1,000, got ${chipAfterSwitch().toLocaleString('en-US')}`)

globalThis['__stEvents_A']['session.usage']({ payload: { usage: { total: 88888888 } }, session_id: WINDOWS.a.runtime, type: 'session.usage' })
await wait(250)

edgeAssert('the previous session stops counting', !((windowA.container.textContent ?? '').includes('88,888,888')), 'a tick from the abandoned session was adopted')

if (edge.length) {
  console.error('\nFAIL (edge cases) — a situation the chip must survive:\n' + edge.map(item => `  • ${item}`).join('\n'))
  fs.rmSync(tmph, { force: true, recursive: true })
  process.exit(1)
}

fs.rmSync(tmph, { force: true, recursive: true })

console.log(`PASS — mount clean · streamed chunks → "${expected}" · chip error contained · two sessions isolated (A ${(aRow + 100).toLocaleString("en-US")} vs B ${bOwn})`)
process.exit(0)
