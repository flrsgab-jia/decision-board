import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'decision-board',
  component: 'Pane',
  requestId: 'decision-board',
  props: {
    title: 'Decisions',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const engine = (on: any) => {
  on('command.register', () => ({ value: { command: 'board' } }))
  on('tool.register', () => ({ value: { tool: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.every', () => ({ value: () => {} }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('a card shows, keeps its number, and clears only when closed', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'mcp__decision-board__add',
    source: 'SMST',
    ask: 'Send the draft',
    recommendation: 'Yes',
  })
  await $.tool.call({
    tool: 'mcp__decision-board__add',
    source: 'Decora Home',
    ask: 'Keep the override',
    recommendation: 'Yes',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /D1 · SMST/ }))?.text).toContain('D1 · SMST')
  expect((await ui.find({ type: 'Text', text: /D2 · Decora/ }))?.text).toContain('D2 · Decora Home')
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__decision-board__close', ids: [1] })

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /D1 · SMST/ })).toBeUndefined()
  expect((await after.find({ type: 'Text', text: /D2 · Decora/ }))?.text).toContain('D2 · Decora Home')
  await after.unmount()
})

test('an empty board says so', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing waiting on you.')
  await ui.unmount()
})

// #181 piece 5: a click on a confirm card records through confirm.py. The engine's
// process.run is mocked here, so no python runs and no state.json is touched.
const confirmEngine = (on: any, exitCode = 0, stderr = '') => {
  engine(on)
  const runs: string[][] = []
  const prompts: string[] = []
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    runs.push([...e.argv])
    return { value: { exitCode, stdout: '{}', stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  return { runs, prompts }
}

const start = async ($: any) => $.session.start({ cwd: '/ws', surface: 'terminal', isInteractive: true })

const addConfirm = ($: any, extra: object = {}) =>
  $.tool.call({
    tool: 'mcp__decision-board__add',
    source: 'Acme',
    ask: 'Which revenue basis?',
    recommendation: 'Bank',
    options: [
      { label: 'Bank', description: '140.4M', values: { basis: 'bank', revenue: 140400000 } },
      { label: 'AFS', description: '120M', values: { basis: 'afs', revenue: 120000000 } },
    ],
    confirm: { borrower: 'Acme Trading', item: 'revenue_basis', stage: '04-scoring' },
    ...extra,
  })

const arg = (argv: string[] | undefined, flag: string): string =>
  argv && argv.includes(flag) ? (argv[argv.indexOf(flag) + 1] ?? '') : ''

test('a confirm card click records the exact item and values, once', async ($, on) => {
  const { runs, prompts } = confirmEngine(on)
  await start($)
  await addConfirm($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pick-1-1' })
  expect(runs.length).toBe(1)
  const a = runs[0] ?? []
  expect(a[1]).toBe('/ws/.claude/coordinator/confirm.py')
  expect(a[2]).toBe('record')
  expect(arg(a, '--borrower')).toBe('Acme Trading')
  expect(arg(a, '--card')).toBe('D1')
  expect(arg(a, '--item')).toBe('revenue_basis')
  expect(JSON.parse(arg(a, '--values'))).toEqual({ basis: 'afs', revenue: 120000000 })
  expect(arg(a, '--choice')).toBe('AFS')
  expect(arg(a, '--stage')).toBe('04-scoring')
  expect(a.includes('--dry-run')).toBe(false)
  expect(prompts[0]).toBe('D1: AFS (recorded as confirmed_by_gab: Acme Trading revenue_basis)')
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /Recorded: AFS/ }))?.text).toContain('Recorded: AFS')
  expect(await after.find({ type: 'Button', key: 'pick-1-0' })).toBeUndefined()
  await after.unmount()
})

test('Other and plain cards never record', async ($, on) => {
  const { runs, prompts } = confirmEngine(on)
  await start($)
  await addConfirm($)
  await $.tool.call({ tool: 'mcp__decision-board__add', source: 'Main', ask: 'Send it?', recommendation: 'Yes' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'reply-1' })
  await ui.press({ key: 'ok-2' })
  expect(runs.length).toBe(0)
  expect(prompts).toEqual(['D2 ok'])
  await ui.unmount()
})

test('an OK confirm card records confirm.values; dry run passes --dry-run', async ($, on) => {
  const { runs, prompts } = confirmEngine(on)
  await start($)
  await $.tool.call({
    tool: 'mcp__decision-board__add',
    source: 'Acme',
    ask: 'Use 6 months of statements?',
    recommendation: 'Yes',
    confirm: { borrower: 'Acme Trading', item: 'statement_months', values: { months: 6 }, dryRun: true },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'ok-1' })
  expect(runs.length).toBe(1)
  expect(JSON.parse(arg(runs[0], '--values'))).toEqual({ months: 6 })
  expect(arg(runs[0], '--choice')).toBe('OK')
  expect(runs[0]?.includes('--dry-run')).toBe(true)
  expect(prompts[0]).toBe('D1 ok (dry run, not written)')
  await ui.unmount()
})

test('a refused record says so in the answer', async ($, on) => {
  const { prompts } = confirmEngine(on, 3, 'error: duplicate: D1 already recorded')
  await start($)
  await addConfirm($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'pick-1-0' })
  expect(prompts[0]).toBe('D1: Bank (NOT recorded in state.json: duplicate: D1 already recorded)')
  await ui.unmount()
})

test('a new card for the same borrower and item supersedes the open one', async ($, on) => {
  const { runs } = confirmEngine(on)
  await start($)
  await addConfirm($)
  const r = await addConfirm($)
  expect(JSON.stringify(r)).toContain('Superseded D1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Superseded by D2/ }))?.text).toContain('Superseded by D2')
  expect(await ui.find({ type: 'Button', key: 'pick-1-0' })).toBeUndefined()
  await ui.press({ key: 'pick-2-0' })
  expect(arg(runs[0], '--card')).toBe('D2')
  await ui.unmount()
})

test('confirm cards that do not name exact values are refused', async ($, on) => {
  confirmEngine(on)
  await start($)
  const no = async (extra: object) => JSON.stringify(await addConfirm($, extra))
  expect(await no({ confirm: { borrower: 'Acme Trading' } })).toContain('Not added')
  expect(await no({ confirm: { borrower: '../x', item: 'i' } })).toContain('not a path')
  expect(await no({ confirm: { borrower: 'A', item: 'i', stage: 'scoring' } })).toContain('Not added')
  expect(
    await no({ options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }),
  ).toContain('values on at least one option')
  expect(
    await no({ options: [{ label: 'A', description: 'a', values: {} }, { label: 'B', description: 'b' }] }),
  ).toContain('Not added')
  expect(
    await no({ options: [{ label: 'A', description: 'a', values: { x: { y: 1 } } }, { label: 'B', description: 'b' }] }),
  ).toContain('Not added')
  expect(await no({ confirm: undefined })).toContain('only count with confirm')
  expect(await no({ options: undefined })).toContain('needs confirm.values')
  const list = await $.tool.call({ tool: 'mcp__decision-board__list' })
  expect(JSON.stringify(list)).toContain('No open decisions')
})

// Cycle times (Gab Q5): closing a card runs stage_times.py touch for its borrower
// (confirm.borrower first, else source). process.run is mocked: nothing is written.
test('closing a card counts a Gab touch for its borrower', async ($, on) => {
  const { runs } = confirmEngine(on)
  await start($)
  await $.tool.call({ tool: 'mcp__decision-board__add', source: 'Decora Home', ask: 'Keep it?', recommendation: 'Yes' })
  await addConfirm($)
  await $.tool.call({ tool: 'mcp__decision-board__close', ids: [1, 2] })
  const touches = runs.filter(a => a[2] === 'touch')
  expect(touches.length).toBe(2)
  expect(touches[0]?.[1]).toBe('/ws/Foresight/projects/credit-analysis/credit_analysis/stage_times.py')
  expect(touches[0]?.[3]).toBe('Decora Home')
  expect(arg(touches[0], '--card')).toBe('D1')
  expect(touches[1]?.[3]).toBe('Acme Trading')
})

// Batch card: one card per borrower per moment, several lines, one answer.
const addBatch = ($: any, extra: object = {}) =>
  $.tool.call({
    tool: 'mcp__decision-board__add',
    source: 'Acme',
    ask: 'Scoring calls for Acme',
    batch: {
      borrower: 'Acme Trading',
      stage: '04-scoring',
      lines: [
        {
          item: 'revenue_basis',
          text: 'Revenue basis',
          recommendation: 'Bank',
          options: [
            { label: 'Bank', description: '140.4M', values: { basis: 'bank' } },
            { label: 'AFS', description: '120M', values: { basis: 'afs' } },
          ],
        },
        {
          item: 'debt_basis',
          text: 'Debt basis',
          recommendation: 'Declared',
          options: [
            { label: 'Declared', description: '12M', values: { basis: 'declared' } },
            { label: 'Estimated', description: '15M', values: { basis: 'estimated' } },
          ],
        },
        {
          item: 'note',
          text: 'Mention the late account',
          recommendation: 'Yes',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        },
      ],
      ...extra,
    },
  })

test('Approve all recos records every line with values, in one answer', async ($, on) => {
  const { runs, prompts } = confirmEngine(on)
  await start($)
  expect(JSON.stringify(await addBatch($))).toContain('Added D1')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /1\. Revenue basis/ }))?.text).toBe('1. Revenue basis')
  await ui.press({ key: 'approve-1' })
  expect(runs.length).toBe(2)
  expect(runs.map(a => arg(a, '--item'))).toEqual(['revenue_basis', 'debt_basis'])
  expect(runs.map(a => arg(a, '--card'))).toEqual(['D1', 'D1'])
  expect(arg(runs[0], '--ask')).toBe('Revenue basis')
  expect(arg(runs[0], '--stage')).toBe('04-scoring')
  expect(JSON.parse(arg(runs[1], '--values'))).toEqual({ basis: 'declared' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('D1: Approved all recos (Acme Trading, 04-scoring)')
  expect(prompts[0]).toContain('1. Revenue basis: Bank (reco), recorded as confirmed_by_gab: revenue_basis')
  expect(prompts[0]).toContain('3. Mention the late account: Yes (reco), no values, not recorded')
  await ui.unmount()
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /Recorded: Approved all recos/ }))?.text).toBeDefined()
  expect(await after.find({ type: 'Button', key: 'approve-1' })).toBeUndefined()
  await after.unmount()
})

test('Sign off takes the changed lines; untouched lines keep the reco', async ($, on) => {
  const { runs, prompts } = confirmEngine(on)
  await start($)
  await addBatch($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'bl-1-1-1' })   // Debt basis -> Estimated
  await ui.press({ key: 'signoff-1' })
  expect(runs.length).toBe(2)
  expect(arg(runs[0], '--choice')).toBe('Bank')
  expect(arg(runs[1], '--choice')).toBe('Estimated')
  expect(JSON.parse(arg(runs[1], '--values'))).toEqual({ basis: 'estimated' })
  expect(prompts).toEqual([expect.stringContaining('D1: Signed off, 1 changed')])
  expect(prompts[0]).toContain('2. Debt basis: Estimated (changed from Declared)')
  await ui.unmount()
})

test('a batch card refuses bad lines and supersedes the open one', async ($, on) => {
  confirmEngine(on)
  await start($)
  const no = async (extra: object) => JSON.stringify(await addBatch($, extra))
  expect(await no({ borrower: '../x' })).toContain('not a path')
  expect(await no({ lines: [] })).toContain('1 to 15 lines')
  expect(
    await no({ lines: [{ item: 'a', text: 'A', recommendation: 'Z', options: [{ label: 'X' }, { label: 'Y' }] }] }),
  ).toContain("one option's exact label")
  expect(
    await no({ lines: [{ item: 'a', text: 'A', recommendation: 'X', options: [{ label: 'X' }] }] }),
  ).toContain('2 to 4 options')
  const dup = { item: 'a', text: 'A', recommendation: 'X', options: [{ label: 'X' }, { label: 'Y' }] }
  expect(await no({ lines: [dup, dup] })).toContain('twice')
  expect(
    JSON.stringify(
      await $.tool.call({
        tool: 'mcp__decision-board__add', source: 'A', ask: 'x', recommendation: 'r',
        batch: { borrower: 'A', lines: [dup] }, confirm: { borrower: 'A', item: 'i' },
      }),
    ),
  ).toContain('leave out options and confirm')
  await addBatch($)
  expect(JSON.stringify(await addBatch($))).toContain('Superseded D1')
  const list = JSON.stringify(await $.tool.call({ tool: 'mcp__decision-board__list' }))
  expect(list).toContain('batch for Acme Trading')
})

test('a refused line is reported, the others still record', async ($, on) => {
  const { runs, prompts } = confirmEngine(on, 3, 'error: duplicate: D1 revenue_basis already recorded')
  await start($)
  await addBatch($, { dryRun: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve-1' })
  expect(runs.every(a => a.includes('--dry-run'))).toBe(true)
  expect(prompts[0]).toContain('NOT recorded: duplicate: D1 revenue_basis already recorded')
  await ui.unmount()
})
