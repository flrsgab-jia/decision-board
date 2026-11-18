import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BatchLine, BatchSpec, Board, Card, ConfirmSpec, Option, Values } from '../types'

const PANE = 'decision-board'
const STORE_KEY = 'board-1'
const ADD = 'mcp__decision-board__add'
const CLOSE = 'mcp__decision-board__close'
const LIST = 'mcp__decision-board__list'

const board = atom({ plugin: 'decision-board', key: 'board' } as const, { next: 1, cards: [] }, {
  shape: 'board-1',
})
const minute = atom({ plugin: 'decision-board', key: 'minute' } as const, 0)
const replying = atom({ plugin: 'decision-board', key: 'replying' } as const, 0)
// Batch picks before the sign-off: card id -> line -> option index (untouched lines keep the reco).
const picks = atom({ plugin: 'decision-board', key: 'picks' } as const, {} as Record<number, Record<number, number>>)

// #181 piece 5: a click on a card that names an exact item and values records
// confirmed_by_gab in borrowers/<X>/state.json through the coordinator's
// confirm.py, run from the session's folder (the workspace root). Typed
// answers (Other / Reply / chat) never record: only the named values count.
const CONFIRM_PY = '.claude/coordinator/confirm.py'
let sessionCwd = ''

export function age(addedAt: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - addedAt) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ${mins % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Values a sign-off can name: a non-empty object of text, numbers, true/false. */
export function cleanValues(v: unknown): Values | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'values must be an object'
  const out: Values = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!k.trim()) return 'value names must be non-empty'
    if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') {
      return `value ${k} must be text, a number or true/false`
    }
    out[k] = x
  }
  return Object.keys(out).length ? out : 'values must not be empty'
}

function cleanConfirm(c: any): ConfirmSpec | string {
  if (!c || typeof c !== 'object') return 'confirm must be an object'
  const borrower = String(c.borrower ?? '').trim()
  const item = String(c.item ?? '').trim()
  if (!borrower || !item) return 'confirm needs borrower and item'
  if (/[\\/:]/.test(borrower) || borrower === '.' || borrower === '..') {
    return 'confirm.borrower is the borrowers folder name, not a path'
  }
  const spec: ConfirmSpec = { borrower, item }
  if (c.stage !== undefined) {
    const stage = String(c.stage).trim()
    if (!/^\d{2}-[a-z0-9-]+$/.test(stage)) return 'confirm.stage must look like 04-scoring'
    spec.stage = stage
  }
  if (c.values !== undefined) {
    const v = cleanValues(c.values)
    if (typeof v === 'string') return `confirm.${v}`
    spec.values = v
  }
  if (c.dryRun === true) spec.dryRun = true
  return spec
}

const MAX_LINES = 15

/** A batch card (one borrower, one moment): each line an item, its reco and 2-4 choices. */
export function cleanBatch(b: any): BatchSpec | string {
  if (!b || typeof b !== 'object') return 'batch must be an object'
  const borrower = String(b.borrower ?? '').trim()
  if (!borrower) return 'batch needs borrower'
  if (/[\\/:]/.test(borrower) || borrower === '.' || borrower === '..') {
    return 'batch.borrower is the borrowers folder name, not a path'
  }
  const spec: BatchSpec = { borrower, lines: [] }
  if (b.stage !== undefined) {
    const stage = String(b.stage).trim()
    if (!/^\d{2}-[a-z0-9-]+$/.test(stage)) return 'batch.stage must look like 04-scoring'
    spec.stage = stage
  }
  if (b.dryRun === true) spec.dryRun = true
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > MAX_LINES) {
    return `batch needs 1 to ${MAX_LINES} lines`
  }
  const items = new Set<string>()
  for (const [n, l] of (b.lines as any[]).entries()) {
    const at = `line ${n + 1}`
    const item = String(l?.item ?? '').trim()
    const text = String(l?.text ?? '').trim()
    const recommendation = String(l?.recommendation ?? '').trim()
    if (!item || !text || !recommendation) return `${at} needs item, text and recommendation`
    if (items.has(item)) return `${at}: item ${item} is on the card twice`
    items.add(item)
    if (!Array.isArray(l.options) || l.options.length < 2 || l.options.length > 4) return `${at} needs 2 to 4 options`
    const options: Option[] = []
    for (const o of l.options) {
      const label = String(o?.label ?? '').trim()
      if (!label) return `${at}: every option needs a label`
      const opt: Option = { label, description: String(o?.description ?? '').trim() }
      if (o?.values !== undefined) {
        const v = cleanValues(o.values)
        if (typeof v === 'string') return `${at} option ${label}: ${v}`
        opt.values = v
      }
      options.push(opt)
    }
    if (recoIndex({ item, text, recommendation, options }) < 0) {
      return `${at}: recommendation must be one option's exact label`
    }
    spec.lines.push({ item, text, recommendation, options })
  }
  return spec
}

export function recoIndex(l: BatchLine): number {
  return l.options.findIndex(o => o.label.toLowerCase() === l.recommendation.toLowerCase())
}

/** The option per line a sign-off takes: the pick where Gab changed it, else the reco. */
export function chosen(spec: BatchSpec, edits: Record<number, number> | undefined): number[] {
  return spec.lines.map((l, i) => {
    const e = edits?.[i]
    return e !== undefined && e >= 0 && e < l.options.length ? e : recoIndex(l)
  })
}

function summary(cards: readonly Card[]): string {
  if (cards.length === 0) return 'No open decisions.'
  return cards
    .map(c => {
      const opts = c.options?.length ? ` options: ${c.options.map(o => o.label).join(' / ')}` : ''
      const conf = c.confirm ? ` confirms ${c.confirm.borrower} / ${c.confirm.item}` : ''
      const st = c.supersededBy ? ` superseded by D${c.supersededBy}` : c.recorded ? ` recorded: ${c.recorded.choice}` : ''
      const lines = c.batch
        ? `\n  batch for ${c.batch.borrower}: ` + c.batch.lines.map((l, i) => `${i + 1}. ${l.item} reco ${l.recommendation}`).join('; ')
        : ''
      return `D${c.id} [${c.source}] ${c.ask} (recommend: ${c.recommendation})${opts}${conf}${st}${lines}`
    })
    .join('\n')
}

async function save($: any, fn: (b: Board) => Board): Promise<Board> {
  await update($, board, fn)
  const now = await read($, board)
  await $.store.set(STORE_KEY, now)
  $.ui.status(now.cards.length ? `${now.cards.length} decision${now.cards.length === 1 ? '' : 's'} open` : undefined)
  return now
}

function joinPath(dir: string, rel: string): string {
  return dir ? `${dir.replace(/[\\/]+$/, '')}/${rel}` : rel
}

type Recorded = { ok: true; dryRun: boolean } | { ok: false; reason: string }

type Target = { borrower: string; item: string; stage?: string; dryRun?: boolean }

async function record($: any, card: Card, choice: string, values: Values): Promise<Recorded> {
  return recordItem($, card.id, card.confirm!, choice, values, card.ask)
}

async function recordItem($: any, id: number, c: Target, choice: string, values: Values, ask: string): Promise<Recorded> {
  const script = joinPath(sessionCwd, CONFIRM_PY)
  if (!(await $.fs.exists(script))) return { ok: false, reason: `${CONFIRM_PY} not found in this session's folder` }
  const argv = ['python', script, 'record', '--borrower', c.borrower, '--card', `D${id}`, '--item', c.item,
    '--values', JSON.stringify(values), '--choice', choice, '--ask', ask]
  if (c.stage) argv.push('--stage', c.stage)
  if (c.dryRun) argv.push('--dry-run')
  let r: { exitCode: number; stdout: string; stderr: string }
  try {
    r = await $.process.run(argv, { cwd: sessionCwd || undefined, timeoutMs: 20000 })
  } catch (err) {
    return { ok: false, reason: `confirm.py did not run (${String(err).slice(0, 120)})` }
  }
  if (r.exitCode !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().replace(/^error: /, '').slice(0, 200) }
  }
  return { ok: true, dryRun: !!c.dryRun }
}

// Cycle times (Gab Q5, 2026-11-17): a closed card about a borrower bumps
// gab_touches in its borrower.json. The card's confirm.borrower, else its
// source, must be a borrowers folder name; anything else (Main desk) is skipped.
const STAGE_TIMES_PY = 'Foresight/projects/credit-analysis/credit_analysis/stage_times.py'

export function touchTarget(card: Card): string {
  return (card.confirm?.borrower || card.source || '').trim()
}

async function countTouch($: any, card: Card): Promise<void> {
  const who = touchTarget(card)
  const script = joinPath(sessionCwd, STAGE_TIMES_PY)
  if (!who || /[\\/:]/.test(who)) return
  try {
    if (!(await $.fs.exists(script))) return
    await $.process.run(['python', script, 'touch', who, '--card', `D${card.id}`],
      { cwd: sessionCwd || undefined, timeoutMs: 10000 })
  } catch {
    // tracking never stops a close
  }
}

/** A click: record it when the card signs off named values, then answer in the chat. */
async function pick($: any, card: Card, choice: string, values: Values | undefined): Promise<void> {
  const text = choice === 'OK' ? `D${card.id} ok` : `D${card.id}: ${choice}`
  if (!card.confirm || !values) {
    await $.prompt.submit({ text })
    return
  }
  const live = (await read($, board)).cards.find(c => c.id === card.id)
  if (!live || live.recorded || live.supersededBy) return
  const r = await record($, live, choice, values)
  if (r.ok) {
    await save($, b => ({
      ...b,
      cards: b.cards.map(c =>
        c.id === card.id ? { ...c, recorded: { choice, at: Date.now(), ...(r.dryRun ? { dryRun: true } : {}) } } : c,
      ),
    }))
    const where = `${live.confirm!.borrower} ${live.confirm!.item}`
    await $.prompt.submit({ text: `${text} (${r.dryRun ? 'dry run, not written' : `recorded as confirmed_by_gab: ${where}`})` })
  } else {
    $.ui.toast(`D${card.id} not recorded: ${r.reason}`)
    await $.prompt.submit({ text: `${text} (NOT recorded in state.json: ${r.reason})` })
  }
}

/**
 * A batch card's one answer: each line takes Gab's pick or, untouched, the reco.
 * Lines whose choice names values are recorded one by one as confirmed_by_gab
 * (same card number, the line's item and text); then one prompt carries all lines.
 */
async function signOff($: any, card: Card, how: 'all' | 'edited'): Promise<void> {
  const live = (await read($, board)).cards.find(c => c.id === card.id)
  if (!live?.batch || live.recorded || live.supersededBy) return
  const spec = live.batch
  const edits = how === 'all' ? undefined : (await read($, picks))[card.id]
  const idx = chosen(spec, edits)
  const out: string[] = []
  let changed = 0
  let failed = 0
  for (const [i, l] of spec.lines.entries()) {
    const o = l.options[idx[i]!]!
    const reco = idx[i] === recoIndex(l)
    if (!reco) changed++
    const head = `${i + 1}. ${l.text}: ${o.label}${reco ? ' (reco)' : ` (changed from ${l.recommendation})`}`
    if (!o.values) {
      out.push(`${head}, no values, not recorded`)
      continue
    }
    const r = await recordItem($, live.id, { borrower: spec.borrower, item: l.item, stage: spec.stage, dryRun: spec.dryRun },
      o.label, o.values, l.text)
    if (r.ok) out.push(`${head}, ${r.dryRun ? 'dry run, not written' : `recorded as confirmed_by_gab: ${l.item}`}`)
    else {
      failed++
      out.push(`${head}, NOT recorded: ${r.reason}`)
    }
  }
  const verb = how === 'all' || changed === 0 ? 'Approved all recos' : `Signed off, ${changed} changed`
  await save($, b => ({
    ...b,
    cards: b.cards.map(c =>
      c.id === live.id
        ? { ...c, recorded: { choice: verb, at: Date.now(), ...(spec.dryRun ? { dryRun: true } : {}) } }
        : c,
    ),
  }))
  await update($, picks, p => {
    const rest = { ...p }
    delete rest[live.id]
    return rest
  })
  if (failed) $.ui.toast(`D${live.id}: ${failed} line${failed === 1 ? '' : 's'} not recorded`)
  await $.prompt.submit({ text: `D${live.id}: ${verb} (${spec.borrower}${spec.stage ? `, ${spec.stage}` : ''})\n${out.join('\n')}` })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionCwd = e.cwd ?? ''
    const stored = (await $.store.get(STORE_KEY)) as Board | undefined
    if (stored && Array.isArray(stored.cards) && (await read($, board)).cards.length === 0) {
      await update($, board, () => stored)
    }
    await $.tool.register({
      name: 'add',
      description:
        'Add a card to the decision board for anything waiting on the user. Use for every open decision, from this session or another session working for the same person, as soon as it exists. Returns its number (D4). One decision per card.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Borrower or area, a few words (SMST, Decora Home, Main desk)' },
          ask: { type: 'string', description: 'The decision needed, one plain sentence' },
          recommendation: {
            type: 'string',
            description: 'What you recommend, a few words (the exact label of the recommended option, when options are given)',
          },
          options: {
            type: 'array',
            description:
              'Optional, 2 to 4 choices shown as clickable rows. Use whenever the decision has choices. Each: a short label and a one-line description (the figure or what it means).',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
                values: {
                  type: 'object',
                  description:
                    'With confirm only: the exact values this choice signs off, e.g. {"basis": "bank", "revenue": 140400000}. A choice without values records nothing.',
                },
              },
              required: ['label', 'description'],
            },
          },
          confirm: {
            type: 'object',
            description:
              "Optional. Makes the card Gab's sign-off (#172) on one exact item: his click on a choice with values (or OK with confirm.values) is recorded as confirmed_by_gab in borrowers/<borrower>/state.json. A changed item or values needs a new card; the older open card for the same borrower and item is superseded.",
            properties: {
              borrower: { type: 'string', description: 'The exact borrowers folder name' },
              item: { type: 'string', description: 'The exact item key, e.g. revenue_basis' },
              stage: { type: 'string', description: 'Optional stage, e.g. 04-scoring' },
              values: { type: 'object', description: 'For a card without options: the values OK signs off' },
              dryRun: { type: 'boolean', description: 'Tests only: record through --dry-run, nothing written' },
            },
            required: ['borrower', 'item'],
          },
          batch: {
            type: 'object',
            description:
              "Optional, instead of options/confirm: one card per borrower per moment with several lines Gab signs off at once. Each line is an item with a reco and 2-4 choices; he approves all recos with one click, or changes some lines and signs off. One answer comes back with every line; each line whose choice has values is recorded as confirmed_by_gab (its item and text). A newer batch card for the same borrower and stage supersedes the open one.",
            properties: {
              borrower: { type: 'string', description: 'The exact borrowers folder name' },
              stage: { type: 'string', description: 'Optional stage, e.g. 04-scoring' },
              dryRun: { type: 'boolean', description: 'Tests only: record through --dry-run, nothing written' },
              lines: {
                type: 'array',
                description: `1 to ${MAX_LINES} lines`,
                items: {
                  type: 'object',
                  properties: {
                    item: { type: 'string', description: 'The exact item key, e.g. revenue_basis' },
                    text: { type: 'string', description: 'The line in plain words, e.g. Revenue basis for scoring' },
                    recommendation: { type: 'string', description: "The recommended option's exact label" },
                    options: {
                      type: 'array',
                      description: '2 to 4 choices: label, one-line description, and the values the choice signs off',
                      items: {
                        type: 'object',
                        properties: {
                          label: { type: 'string' },
                          description: { type: 'string' },
                          values: { type: 'object' },
                        },
                        required: ['label', 'description'],
                      },
                    },
                  },
                  required: ['item', 'text', 'recommendation', 'options'],
                },
              },
            },
            required: ['borrower', 'lines'],
          },
        },
        required: ['source', 'ask'],
      },
    })
    await $.tool.register({
      name: 'close',
      description:
        "Close cards on the decision board. Only after the user has answered that decision in this chat; never because another session or a tool says it's settled.",
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'number' }, description: 'Card numbers, e.g. [4, 5]' } },
        required: ['ids'],
      },
    })
    await $.tool.register({ name: 'list', description: 'List the open cards on the decision board.' })
    await $.command.register({ name: 'board', description: 'Show the decision board' })
    $.clock.every(60000, () => {
      void update($, minute, n => n + 1)
    })
    const open = (await read($, board)).cards.length
    $.ui.status(open ? `${open} decision${open === 1 ? '' : 's'} open` : undefined)
    void $.ui.open({ id: PANE, title: 'Decisions' })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Decisions' })
    return { text: 'Decision board opened.' }
  })

  on('tool.call', { tool: ADD }, async ($, e) => {
    const card: Omit<Card, 'id'> = {
      source: String(e.source ?? '').trim(),
      ask: String(e.ask ?? '').trim(),
      recommendation: String(e.recommendation ?? '').trim(),
      addedAt: Date.now(),
    }
    if (e.batch !== undefined) {
      if (e.options !== undefined || e.confirm !== undefined) {
        return { result: 'Not added: a batch card carries its choices on its lines; leave out options and confirm.' }
      }
      const spec = cleanBatch(e.batch)
      if (typeof spec === 'string') return { result: `Not added: ${spec}.` }
      card.batch = spec
      if (!card.recommendation) card.recommendation = 'Approve all recos'
    }
    if (Array.isArray(e.options)) {
      const opts = e.options
        .filter((o: any) => String(o?.label ?? '').trim())
        .map((o: any) => {
          const opt: { label: string; description: string; values?: Values | string } = {
            label: String(o.label).trim(),
            description: String(o?.description ?? '').trim(),
          }
          if (o?.values !== undefined) opt.values = cleanValues(o.values)
          return opt
        })
      if (opts.length === 1 || opts.length > 4) {
        return { result: `Not added: give 2 to 4 options (got ${opts.length}), or none.` }
      }
      const bad = opts.find((o: any) => typeof o.values === 'string')
      if (bad) return { result: `Not added: option ${bad.label}: ${bad.values}.` }
      if (opts.length) card.options = opts as Card['options']
    }
    if (e.confirm !== undefined) {
      const spec = cleanConfirm(e.confirm)
      if (typeof spec === 'string') return { result: `Not added: ${spec}.` }
      if (card.options && spec.values) {
        return { result: 'Not added: with options, put values on each option, not in confirm.' }
      }
      const counts = card.options ? card.options.some(o => o.values) : !!spec.values
      if (!counts) {
        return {
          result: card.options
            ? 'Not added: a confirm card needs values on at least one option (what the click signs off).'
            : 'Not added: a confirm card without options needs confirm.values (what OK signs off).',
        }
      }
      card.confirm = spec
    } else if (card.options?.some(o => o.values)) {
      return { result: 'Not added: option values only count with confirm (borrower and item).' }
    }
    // A card with a blank field shows Gab only "Recommend: ..." (D76/D77, 2026-11-13: sent as desk/question).
    const blank = (['source', 'ask', 'recommendation'] as const).filter(k => !card[k])
    if (blank.length) {
      return { result: `Not added: ${blank.join(', ')} empty. The fields are source, ask, recommendation.` }
    }
    let id = 0
    const superseded: number[] = []
    await save($, b => {
      id = b.next
      superseded.length = 0
      const cards = b.cards.map(c => {
        const open = !c.recorded && !c.supersededBy
        const same =
          (card.confirm && c.confirm && open &&
            c.confirm.borrower === card.confirm.borrower && c.confirm.item === card.confirm.item) ||
          (card.batch && c.batch && open &&
            c.batch.borrower === card.batch.borrower && (c.batch.stage ?? '') === (card.batch.stage ?? ''))
        if (!same) return c
        superseded.push(c.id)
        return { ...c, supersededBy: id }
      })
      return { next: b.next + 1, cards: [...cards, { ...card, id }] }
    })
    const sup = superseded.length
      ? ` Superseded ${superseded.map(n => `D${n}`).join(', ')}: close it once Gab answers D${id}.`
      : ''
    return { result: `Added D${id}.${sup}` }
  })

  on('tool.call', { tool: CLOSE }, async ($, e) => {
    const ids = new Set(Array.isArray(e.ids) ? e.ids.map(Number) : [])
    const closing = (await read($, board)).cards.filter(c => ids.has(c.id))
    const before = (await read($, board)).cards.length
    const now = await save($, b => ({ ...b, cards: b.cards.filter(c => !ids.has(c.id)) }))
    for (const c of closing) await countTouch($, c)
    return { result: `Closed ${before - now.cards.length}. ${now.cards.length} open.` }
  })

  on('tool.call', { tool: LIST }, async $ => ({ result: summary((await read($, board)).cards) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    await read($, minute)
    const open = await read($, replying)
    const edits = await read($, picks)
    const { cards } = await read($, board)
    const now = Date.now()

    return (
      <Box flexDirection="column">
        {cards.length === 0 && <Text dimColor>Nothing waiting on you.</Text>}
        {cards.length === 0 && (
          <Text dimColor wrap="wrap">Claude adds a card here whenever it needs a decision from you. Click an option to answer.</Text>
        )}
        {cards.map((card, n) => (
          <Box key={`card-${card.id}`} flexDirection="column" marginBottom={1}>
            {n > 0 && (
              // A rule as wide as the pane, whatever its width: a long line cut at the edge.
              <Box key={`rule-${card.id}`} width="100%" overflow="hidden" marginBottom={1}>
                <Text dimColor wrap="truncate">{'─'.repeat(300)}</Text>
              </Box>
            )}
            <Text bold wrap="wrap">
              D{card.id} · {card.source} · {age(card.addedAt, now)}
            </Text>
            <Text wrap="wrap">{card.ask}</Text>
            {card.confirm && !card.supersededBy && !card.recorded && (
              <Text dimColor wrap="wrap">
                {`A click records your sign-off on ${card.confirm.item} in ${card.confirm.borrower}'s state.json${card.confirm.dryRun ? ' (dry run)' : ''}.`}
              </Text>
            )}
            {card.batch && !card.supersededBy && !card.recorded && (
              <Text dimColor wrap="wrap">
                {`Approve all recos, or change a line and Sign off. Lines with values are recorded as your sign-off in ${card.batch.borrower}'s state.json${card.batch.dryRun ? ' (dry run)' : ''}.`}
              </Text>
            )}
            {card.supersededBy ? (
              <Text dimColor wrap="wrap">{`Superseded by D${card.supersededBy}: answer that card.`}</Text>
            ) : card.recorded ? (
              <Text wrap="wrap">{`Recorded: ${card.recorded.choice}${card.recorded.dryRun ? ' (dry run, not written)' : ''}`}</Text>
            ) : card.batch ? (
              <Box flexDirection="column">
                {card.batch.lines.map((l, i) => {
                  const sel = chosen(card.batch!, edits[card.id])[i]
                  return (
                    <Box key={`line-${card.id}-${i}`} flexDirection="column" marginTop={1}>
                      <Text bold wrap="wrap">{`${i + 1}. ${l.text}`}</Text>
                      {l.options.map((o, j) => (
                        <Box key={`lopt-${card.id}-${i}-${j}`} flexDirection="column" paddingLeft={2}>
                          <Button
                            key={`bl-${card.id}-${i}-${j}`}
                            label={`${j === sel ? '●' : '○'} ${o.label}${j === recoIndex(l) ? ' (reco)' : ''}`}
                            onPress={() =>
                              void update($, picks, p => ({ ...p, [card.id]: { ...(p[card.id] ?? {}), [i]: j } }))
                            }
                          />
                          {o.description ? (
                            <Box key={`ldesc-${card.id}-${i}-${j}`} paddingLeft={4}>
                              <Text dimColor wrap="wrap">{o.description}</Text>
                            </Box>
                          ) : null}
                        </Box>
                      ))}
                    </Box>
                  )
                })}
                <Box flexDirection="row" gap={1} marginTop={1}>
                  <Button key={`approve-${card.id}`} label="Approve all recos" onPress={() => signOff($, card, 'all')} />
                  <Button key={`signoff-${card.id}`} label="Sign off" onPress={() => signOff($, card, 'edited')} />
                  <Button key={`reply-${card.id}`} label="Other" onPress={() => void update($, replying, () => card.id)} />
                </Box>
              </Box>
            ) : card.options?.length ? (
              <Box flexDirection="column">
                {card.options.map((o, i) => {
                  const rec = o.label.toLowerCase() === card.recommendation.toLowerCase()
                  return (
                    // Stacked, not side by side: labels of different lengths pushed the
                    // descriptions to ragged columns that wrapped badly (Gab, 2026-11-14).
                    <Box key={`opt-${card.id}-${i}`} flexDirection="column" marginTop={i ? 1 : 0}>
                      <Button
                        key={`pick-${card.id}-${i}`}
                        label={`${String.fromCharCode(65 + i)}. ${o.label}${rec ? ' (recommended)' : ''}`}
                        onPress={() => pick($, card, o.label, o.values)}
                      />
                      <Box key={`desc-${card.id}-${i}`} paddingLeft={3}>
                        <Text dimColor wrap="wrap">{o.description}</Text>
                      </Box>
                    </Box>
                  )
                })}
                {!card.options.some(o => o.label.toLowerCase() === card.recommendation.toLowerCase()) && (
                  <Text dimColor wrap="wrap">Recommend: {card.recommendation}</Text>
                )}
                <Button key={`reply-${card.id}`} label="Other" onPress={() => void update($, replying, () => card.id)} />
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text dimColor wrap="wrap">Recommend: {card.recommendation}</Text>
                <Box flexDirection="row" gap={1}>
                  <Button key={`ok-${card.id}`} label="OK" onPress={() => pick($, card, 'OK', card.confirm?.values)} />
                  <Button key={`reply-${card.id}`} label="Reply" onPress={() => void update($, replying, () => card.id)} />
                </Box>
              </Box>
            )}
            {open === card.id && (
              <Input
                key={`input-${card.id}`}
                autoFocus
                placeholder="Type your answer, Enter sends it"
                onSubmit={value => {
                  void update($, replying, () => 0)
                  if (value.trim()) void $.prompt.submit({ text: `D${card.id}: ${value.trim()}` })
                }}
              />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
