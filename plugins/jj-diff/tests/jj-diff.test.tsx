import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { diffArgv, dirOf, parseDiff, totals } from '../hooks/diff'

const PANE = {
  plugin: 'jj-diff',
  component: 'Pane',
  requestId: 'jj-diff',
  props: {
    title: 'jj diff',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const FOOTER = { plugin: 'jj-diff', component: 'SessionMode', props: { modes: [] } } as const

const SAMPLE = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' export { a }',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1,2 @@',
  '+# New',
  '+text',
  'diff --git a/old.txt b/gone.txt',
  'rename from old.txt',
  'rename to gone.txt',
  '--- a/old.txt',
  '+++ b/gone.txt',
  '@@ -1 +1 @@',
  '-was',
  '+is',
  '\\ No newline at end of file',
  'diff --git a/img.png b/img.png',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n')

type Run = { argv: readonly string[]; cwd: string | undefined; timeoutMs: number | undefined }

type Repo = {
  roots: Record<string, string>
  diff: string
  runs: Run[]
  listing?: Record<string, string[]>
  diffFailure?: { exitCode: number; stderr: string }
  isOpen?: boolean
}

function fakeJj(on: On, repo: Repo, cwd: string) {
  on('session.cwd', () => ({ value: cwd }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>auto</Text>
  })
  on('ui.open', () => {
    repo.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    repo.isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: repo.isOpen
      ? [{ id: 'jj-diff', title: 'jj diff', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('fs.list', (_, e) => ({
    value: (repo.listing?.[e.path ?? cwd] ?? []).map(name => ({
      name,
      kind: 'dir',
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('fs.exists', (_, e) => ({
    value: Object.keys(repo.roots).some(root => e.path === `${root}/.jj`),
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    const dir = e.init?.cwd
    repo.runs.push({ argv: e.argv, cwd: dir, timeoutMs: e.init?.timeoutMs })
    const done = { isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv.includes('root')) {
      const here = dir ?? ''
      const root = Object.keys(repo.roots)
        .filter(prefix => here === prefix || here.startsWith(`${prefix}/`))
        .sort((a, b) => b.length - a.length)[0]
      if (root === undefined) {
        return {
          value: { ...done, exitCode: 1, stdout: '', stderr: `Error: There is no jj repo in "${here}"\n` },
        }
      }
      return { value: { ...done, exitCode: 0, stdout: `${repo.roots[root]}\n`, stderr: '' } }
    }
    if (repo.diffFailure !== undefined) {
      return { value: { ...done, ...repo.diffFailure, stdout: '' } }
    }
    return { value: { ...done, exitCode: 0, stdout: repo.diff, stderr: '' } }
  })
}

const diffRuns = (repo: Repo) => repo.runs.filter(run => run.argv.includes('diff'))

async function pressFooter($: Engine) {
  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  await footer.press({ key: 'jj-diff-toggle' })
  await footer.unmount()
}

test('the stack diff is the only command, and it only reads', () => {
  const argv = diffArgv()
  expect(argv.slice(-4)).toEqual(['diff', '--git', '-r', 'trunk()..@'])
  expect(argv[0]).toBe('jj')
  expect(argv).toContain('--no-pager')
  expect(argv.some(word => /^(new|describe|squash|commit|edit|abandon)$/.test(word))).toBe(false)
  expect(dirOf('/ws/main/src/a.ts')).toBe('/ws/main/src')
  expect(dirOf('/a.ts')).toBe('/')
  expect(dirOf('notes.md')).toBe('.')
})

test('the git diff is parsed into files with counts', () => {
  const files = parseDiff(SAMPLE)
  expect(files.map(f => f.path)).toEqual(['src/app.ts', 'docs/new.md', 'gone.txt', 'img.png'])
  expect(files[0]).toMatchObject({ status: 'modified', added: 2, removed: 1 })
  expect(files[0]?.hunks[0]?.header).toBe('@@ -1,3 +1,4 @@')
  expect(files[0]?.hunks[0]?.lines.map(l => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
  expect(files[1]).toMatchObject({ status: 'added', added: 2, removed: 0 })
  expect(files[2]).toMatchObject({ status: 'renamed', oldPath: 'old.txt', added: 1, removed: 1 })
  expect(files[2]?.hunks[0]?.lines[2]?.kind).toBe('meta')
  expect(files[3]).toMatchObject({ status: 'binary', added: 0, removed: 0, hunks: [] })
  expect(totals(files)).toEqual({ added: 5, removed: 2 })
  expect(parseDiff('')).toEqual([])
})

test('the footer button opens the pane on the session repo and draws the stack like the built-in diff', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: SAMPLE, runs: [] }
  fakeJj(on, repo, '/ws/main/sub')
  await $.session.start({ cwd: '/ws/main/sub', surface: 'desktop', isInteractive: true })

  const footer = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await footer.find({ key: 'jj-diff-toggle' }))?.text).toBe('jj diff')
  expect((await footer.find({ type: 'Text', text: 'auto' }))?.text).toBe('auto')
  await footer.press({ key: 'jj-diff-toggle' })
  await footer.unmount()
  expect(repo.isOpen).toBe(true)
  expect(diffRuns(repo)[0]?.cwd).toBe('/ws/main')
  expect(diffRuns(repo)[0]?.argv.slice(-2)).toEqual(['-r', 'trunk()..@'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /changed/ }))?.text).toContain('4 files changed')
    expect((await ui.find({ key: 'file:gone.txt' }))?.text).toContain('old.txt → gone.txt')
    expect((await ui.find({ type: 'Text', text: /^\+2$/ }))?.props.color).toBe('diffAddedWord')
    const code = (await ui.findAll({ type: 'Code' })).find(found => found.props.path === 'src/app.ts')
    expect(code?.props.format).toBe('diff')
    expect(code?.text).toContain('+const c = 4')
    expect(code?.text.startsWith('@@ -1,3 +1,4 @@\n')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^⋯/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /\/ws\/main$/ }))?.text).toBe('trunk()..@ · /ws/main')
    expect(await ui.find({ key: 'repo' })).toBeUndefined()
    await ui.unmount()
  }

  await pressFooter($)
  expect(repo.isOpen).toBe(false)
})

test('outside a jj repo the pane finds the jj repos one level down and offers them', async ($, on) => {
  const repo: Repo = {
    roots: { '/home/kkmp/k3': '/home/kkmp/k3', '/home/kkmp/k3-a-wt': '/home/kkmp/k3-a-wt' },
    diff: SAMPLE,
    runs: [],
    listing: { '/home/kkmp': ['docs', 'k3', 'k3-a-wt'] },
  }
  fakeJj(on, repo, '/home/kkmp')
  await $.session.start({ cwd: '/home/kkmp', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  expect(diffRuns(repo)[0]?.cwd).toBe('/home/kkmp/k3')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const picker = await ui.find({ key: 'repo' })
  expect(picker?.props.options).toEqual([
    { value: '/home/kkmp/k3', label: 'k3' },
    { value: '/home/kkmp/k3-a-wt', label: 'k3-a-wt' },
  ])
  await ui.select({ key: 'repo', value: '/home/kkmp/k3-a-wt' })
  expect(diffRuns(repo).at(-1)?.cwd).toBe('/home/kkmp/k3-a-wt')
  await ui.unmount()
})

test('with no jj repo anywhere the pane says what it waits for', async ($, on) => {
  const repo: Repo = { roots: {}, diff: '', runs: [] }
  fakeJj(on, repo, '/elsewhere')
  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  expect(diffRuns(repo)).toHaveLength(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Not a jj repo/ }))?.text).toBe('Not a jj repo: /elsewhere')
    expect((await ui.find({ type: 'Text', text: /follows/ }))?.text).toContain('next file Claude edits')
    await ui.unmount()
  }
})

test('an edit in a secondary workspace without .git switches the pane to it', async ($, on) => {
  const repo: Repo = {
    roots: { '/ws/main': '/ws/main', '/ws/feature': '/ws/feature' },
    diff: SAMPLE,
    runs: [],
  }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  expect(diffRuns(repo)[0]?.cwd).toBe('/ws/main')

  await $.tool.call({ tool: 'Edit', file_path: '/ws/feature/src/lib.rs', old_string: 'a', new_string: 'b' })
  expect(repo.runs.some(run => run.argv.includes('root') && run.cwd === '/ws/feature/src')).toBe(true)
  expect(diffRuns(repo).at(-1)?.cwd).toBe('/ws/feature')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/ws\/feature$/ }))?.text).toBe('trunk()..@ · /ws/feature')
  expect((await ui.find({ key: 'repo' }))?.props.options).toEqual([
    { value: '/ws/feature', label: 'feature' },
    { value: '/ws/main', label: 'main' },
  ])
  await ui.unmount()
})

test('the pane refreshes after an Edit, a Bash call and the refresh button, not after a Read', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  expect(diffRuns(repo)).toHaveLength(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No changes/ }))?.text).toBe('No changes.')

  repo.diff = SAMPLE
  await $.tool.call({ tool: 'Edit', file_path: '/ws/main/src/app.ts', old_string: 'a', new_string: 'b' })
  expect(diffRuns(repo)).toHaveLength(2)
  expect((await ui.find({ key: 'file:src/app.ts' }))?.text).toContain('src/app.ts')

  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(diffRuns(repo)).toHaveLength(3)

  await $.tool.call({ tool: 'Read', file_path: '/ws/main/src/app.ts' })
  expect(diffRuns(repo)).toHaveLength(3)

  await ui.press({ key: 'refresh' })
  expect(diffRuns(repo)).toHaveLength(4)

  await ui.press({ key: 'file:src/app.ts' })
  expect((await ui.findAll({ type: 'Code' })).some(found => found.props.path === 'src/app.ts')).toBe(false)
  expect((await ui.find({ key: 'file:src/app.ts' }))?.text).toContain('▸')
  await ui.unmount()
})

test('a tool call runs no jj while the pane is closed', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/ws/main/a', old_string: 'a', new_string: 'b' })
  expect(repo.runs).toHaveLength(0)
})

test('a failing jj diff is reported in the pane', async ($, on) => {
  const repo: Repo = {
    roots: { '/ws/main': '/ws/main' },
    diff: '',
    runs: [],
    diffFailure: { exitCode: 1, stderr: 'Error: Revision "trunk()" doesn\'t exist\nHint: try jj log\n' },
  }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Revision/ }))?.text).toBe('Error: Revision "trunk()" doesn\'t exist')
    expect(await ui.find({ type: 'Text', text: /No changes/ })).toBeUndefined()
    await ui.unmount()
  }

  repo.diffFailure = { exitCode: 1, stderr: '' }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /exited/ }))?.text).toBe('jj diff exited with code 1')
  await ui.unmount()
})

test('a relative edited path is resolved against the session cwd, not /', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  await $.tool.call({ tool: 'Edit', file_path: 'notes.md', old_string: 'a', new_string: 'b' })
  const rootRuns = repo.runs.filter(run => run.argv.includes('root'))
  expect(rootRuns.some(run => run.cwd === '/')).toBe(false)
  expect(rootRuns.every(run => run.cwd === '/ws/main')).toBe(true)
})

test('refresh inside a tool call uses short timeouts; the footer and the button use long ones', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  expect(diffRuns(repo).at(-1)?.timeoutMs).toBe(60_000)
  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(diffRuns(repo).at(-1)?.timeoutMs).toBe(8_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(diffRuns(repo).at(-1)?.timeoutMs).toBe(60_000)
  await ui.unmount()
})

test('jj root is cached per directory and forgotten when jj diff fails there', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await pressFooter($)
  const edit = { tool: 'Edit', file_path: '/ws/main/src/a.ts', old_string: 'a', new_string: 'b' } as const
  await $.tool.call(edit)
  await $.tool.call(edit)
  await $.tool.call(edit)
  const rootRuns = () => repo.runs.filter(run => run.argv.includes('root'))
  expect(rootRuns().filter(run => run.cwd === '/ws/main/src')).toHaveLength(1)
  expect(rootRuns().filter(run => run.cwd === '/ws/main')).toHaveLength(1)
  expect(diffRuns(repo)).toHaveLength(4)

  repo.diffFailure = { exitCode: 1, stderr: 'Error: The repository is locked\n' }
  await $.tool.call(edit)
  delete repo.diffFailure
  await $.tool.call(edit)
  expect(rootRuns().filter(run => run.cwd === '/ws/main/src')).toHaveLength(2)
})

test('the pane says Loading before the first refresh has settled', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Loading/ }))?.text).toBe('Loading…')
  expect(await ui.find({ type: 'Text', text: /No changes/ })).toBeUndefined()
  await ui.unmount()
})
