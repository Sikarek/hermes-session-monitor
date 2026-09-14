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

const KNOWN = ['atom', 'cn', 'compactNumber', 'host', 'icons', 'Popover', 'PopoverContent', 'PopoverTrigger', 'Tip', 'usePluginI18n', 'useValue']

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
  const tail = names.filter(name => !KNOWN.includes(name)).map(name => `export const ${name} = noop`).join('\n')

  return `
const atomImpl = value => ({ get: () => value, set: () => {}, subscribe: () => () => {} })
const atom = atomImpl
const noop = () => null
const EVENTS = (globalThis[${key}] = {})

export const host = {
  state: {
    activeSessionId: atom(${runtime}),
    busy: atom(false),
    focusedSessionId: atom(${runtime}),
    focusedSessionProfile: atom('default'),
    focusedStoredSessionId: atom(${stored}),
    focusedUsage: atom(null),
    gateway: atom('open'),
    model: atom('deepseek/deepseek-v4.1-flash')
  },
  notify: () => 'toast', notifyError: () => 'toast', navigate: () => {},
  onEvent: (type, handler) => { EVENTS[type] = handler; return () => delete EVENTS[type] },
  request: async method => {
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
  listPersistedSessions: async () => ({
    limit: 1, offset: 0, total: 1,
    sessions: [{
      cache_read_tokens: ${cacheRead}, cache_write_tokens: 0, cost_source: 'provider_models_api',
      cost_status: 'estimated', estimated_cost_usd: 1.3718, id: ${stored},
      input_tokens: 1000, message_count: 7, output_tokens: 500, reasoning_tokens: 100,
      resolved_id: ${runtime}
    }]
  })
}

export const useValue = value => (value && typeof value.get === 'function' ? value.get() : value)
export const usePluginI18n = () => (key, ...args) => [key, ...args].join(' ')
export const compactNumber = value => String(value ?? 0)
export const cn = (...args) => args.filter(Boolean).join(' ')
import { createElement, useEffect } from 'react'
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
export const icons = new Proxy({}, { get: () => noop })
export { atom }
${tail}
`
}

const WINDOWS = {
  a: { cacheRead: 26428800, key: 'A', runtime: 'rtA', stored: 'storedA' },
  b: { cacheRead: 500000, key: 'B', runtime: 'rtB', stored: 'storedB' }
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
    rest: async () => ({}),
    socket: () => () => {},
    storage: { get: () => undefined, remove: () => {}, set: () => {} },
    os: { notify: () => {}, openExternal: () => {}, reveal: () => {} },
    i18n: { register: () => {} }
  }

  let nodes = []

  try {
    const plugin = (await import(modulePath)).default

    plugin.register(ctx)

    if (registered.length === 0) throw new Error('register() contributed nothing')

    nodes = registered
      .map(contribution => (contribution.render ? contribution.render() : contribution.data?.render?.() ?? null))
      .filter(Boolean)

    createRoot(rootEl).render(React.createElement(Boundary, null, nodes))
    await wait(450)
  } catch (error) {
    failures.push(`threw: ${error?.message}\n      ${(error?.stack ?? '').split('\n').slice(1, 4).join('\n      ')}`)
  }

  const markup = rootEl.textContent ?? ''

  console.error = originalError

  return { boundaryCaught, chatter, container: rootEl, failures, markup, nodes }
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
    if (!globalThis['__stEvents_A']?.['reasoning.delta'] || !globalThis['__stEvents_A']?.['message.delta']) {
      throw new Error('plugin did not subscribe to the content streams')
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

    // COMPLETED-CALL contract: a `session.usage` tick for THIS session must be
    // adopted. This path was untested while it shipped a ReferenceError — the
    // app's listener wrapper swallows handler throws, so the chip silently kept
    // an estimate instead of the real total and every test still passed.
    const usageTotal = 5000 // fresh process: the runtime counter starts at 0

    globalThis['__stEvents_A']['session.usage']({
      payload: { usage: { total: usageTotal } },
      session_id: WINDOWS.a.runtime,
      type: 'session.usage'
    })
    await wait(250)

    const afterUsage = container.textContent ?? ''
    const expectedAfterUsage = (stored + usageTotal).toLocaleString('en-US')

    if (!afterUsage.includes(expectedAfterUsage)) {
      throw new Error(`a matching usage tick was not adopted: expected ${expectedAfterUsage} in "${afterUsage.trim().slice(0, 90)}"`)
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
    const panel = document.body.textContent ?? ''
    const expectedTotal = stored.toLocaleString('en-US')

    for (const needle of ['Session monitor', 'Cache hit', 'Cache miss', 'Output', 'Total', 'Cache hit rate', 'Cost']) {
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

    // WIDTH CONTRACT: the popover must not pin a width while the panel declares its
    // own. Pinning w-72 around a w-80 panel clipped 32px off the right edge — the
    // exact "box looks broken" regression.
    const popoverEl = document.querySelector('[data-stub="popover-content"]')
    const panelEl = document.querySelector('[data-slot="session-monitor-panel"]')

    if (!popoverEl || !panelEl) throw new Error('could not locate the popover or the panel element')

    if (!/w-auto/.test(popoverEl.className)) {
      throw new Error(`popover pins a width ("${popoverEl.className}") — that clips the panel`)
    }

    if (!/w-80/.test(panelEl.className)) {
      throw new Error(`panel width class missing ("${panelEl.className}")`)
    }

    // CONTRAST CONTRACT: labels are highlighted, NUMBERS ARE NOT. So no element
    // carrying `text-foreground` may contain a digit, and every label must carry
    // it. (`text-foreground/90` is a different class token and is not counted.)
    const vivid = [...panelEl.querySelectorAll('*')].filter(el => el.classList.contains('text-foreground'))
    const vividText = vivid.map(el => (el.textContent ?? '').trim())
    const numeric = vividText.filter(text => /\d/.test(text))

    if (numeric.length) {
      throw new Error(`numbers must never be highlighted — got: ${numeric.join(' | ').slice(0, 90)}`)
    }

    for (const label of ['Session monitor', 'Cache hit', 'Cache miss', 'Output', 'Total', 'Cache hit rate', 'Cost']) {
      if (!vividText.includes(label)) {
        throw new Error(`label is not highlighted: "${label}" (highlighted: ${vividText.join(' | ').slice(0, 90)})`)
      }
    }

    const expectedShare = ((WINDOWS.a.cacheRead / (WINDOWS.a.cacheRead + 1000 + 500)) * 100).toFixed(2) + '%'
    const expectedTotalText = (WINDOWS.a.cacheRead + 1000 + 500).toLocaleString('en-US')

    if (!panel.includes(expectedShare)) throw new Error(`panel share column missing ${expectedShare} — got: ${panel.slice(0, 220)}`)
    if (document.querySelector('[data-slot="session-monitor-bar"], [data-slot="session-tokens-bar"]')) {
      throw new Error('the segmented bar is back — it was replaced by the share column')
    }
    if (panel.includes('Input (uncached)')) throw new Error("old flat label 'Input (uncached)' is back")

    if (!panel.includes(expectedTotal)) throw new Error(`panel total missing (${expectedTotal}) — got: ${panel.slice(0, 160)}`)

    // Cost figure shown bare (the provenance parenthetical was removed on request).
    if (!panel.includes('$1.3718')) throw new Error(`panel cost missing — got: ${panel.slice(0, 200)}`)

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

fs.rmSync(tmph, { force: true, recursive: true })

console.log(`PASS — mount clean · streamed chunks → "${expected}" · chip error contained · two sessions isolated (A ${(aRow + 100).toLocaleString("en-US")} vs B ${bOwn})`)
process.exit(0)
