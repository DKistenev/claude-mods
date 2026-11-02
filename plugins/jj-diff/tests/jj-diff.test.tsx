import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { diffArgv, parseArgs, parseDiff, totals } from '../hooks/diff'

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

type Run = { argv: readonly string[]; cwd: string | undefined }

type Repo = {
  roots: Record<string, string>
  diff: string
  runs: Run[]
}

function fakeJj(on: On, repo: Repo, cwd: string) {
  on('session.cwd', () => ({ value: cwd }))
  on('command.register', () => ({ value: { command: 'jj-diff' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({
    value: [{ id: 'jj-diff', title: 'jj diff', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    const cwd = e.init?.cwd
    repo.runs.push({ argv: e.argv, cwd })
    const done = { isStdoutTruncated: false, isStderrTruncated: false }
    if (e.argv.includes('root')) {
      const dir = cwd ?? ''
      const root = Object.keys(repo.roots)
        .filter(prefix => dir === prefix || dir.startsWith(`${prefix}/`))
        .sort((a, b) => b.length - a.length)[0]
      if (root === undefined) {
        return {
          value: {
            ...done,
            exitCode: 1,
            stdout: '',
            stderr: `Error: There is no jj repo in "${dir}"\n`,
          },
        }
      }
      return { value: { ...done, exitCode: 0, stdout: `${repo.roots[root]}\n`, stderr: '' } }
    }
    return { value: { ...done, exitCode: 0, stdout: repo.diff, stderr: '' } }
  })
}

const diffRuns = (repo: Repo) => repo.runs.filter(run => run.argv.includes('diff'))

const typed = (args: string) =>
  ({
    command: 'jj-diff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  }) as const

test('argument parsing: mode, rev and path', () => {
  expect(parseArgs('')).toEqual({ mode: 'change', rev: null, path: null })
  expect(parseArgs('cl')).toEqual({ mode: 'cl', rev: null, path: null })
  expect(parseArgs('rev abc123')).toEqual({ mode: 'rev', rev: 'abc123', path: null })
  expect(parseArgs('cl /ws/main')).toEqual({ mode: 'cl', rev: null, path: '/ws/main' })
  expect(parseArgs('/ws/main')).toEqual({ mode: 'change', rev: null, path: '/ws/main' })
  expect(parseArgs('rev')).toHaveProperty('error')
  expect(parseArgs('change a b')).toHaveProperty('error')
})

test('each mode maps to its jj diff command', () => {
  expect(diffArgv('change', null).slice(-4)).toEqual(['diff', '--git', '-r', '@'])
  expect(diffArgv('cl', null).slice(-6)).toEqual(['diff', '--git', '--from', 'trunk()', '--to', '@'])
  expect(diffArgv('rev', 'xyz').slice(-4)).toEqual(['diff', '--git', '-r', 'xyz'])
  for (const argv of [diffArgv('change', null), diffArgv('cl', null), diffArgv('rev', 'x')]) {
    expect(argv[0]).toBe('jj')
    expect(argv).toContain('--no-pager')
    expect(argv.some(word => /^(new|describe|squash|commit|edit|abandon)$/.test(word))).toBe(false)
  }
})

test('the git diff is parsed into files with counts', () => {
  const files = parseDiff(SAMPLE)
  expect(files.map(f => f.path)).toEqual(['src/app.ts', 'docs/new.md', 'gone.txt', 'img.png'])
  expect(files[0]).toMatchObject({ status: 'modified', added: 2, removed: 1 })
  expect(files[0]?.hunks).toHaveLength(1)
  expect(files[0]?.hunks[0]?.header).toBe('@@ -1,3 +1,4 @@')
  expect(files[0]?.hunks[0]?.lines.map(l => l.kind)).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
  expect(files[1]).toMatchObject({ status: 'added', added: 2, removed: 0 })
  expect(files[2]).toMatchObject({ status: 'renamed', oldPath: 'old.txt', added: 1, removed: 1 })
  expect(files[2]?.hunks[0]?.lines[2]?.kind).toBe('meta')
  expect(files[3]).toMatchObject({ status: 'binary', added: 0, removed: 0, hunks: [] })
  expect(totals(files)).toEqual({ added: 5, removed: 2 })
  expect(parseDiff('')).toEqual([])
})

test('/jj-diff cl runs the stack diff in the session cwd and the pane lists the files', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: SAMPLE, runs: [] }
  fakeJj(on, repo, '/ws/main/sub')
  await $.session.start({ cwd: '/ws/main/sub', surface: 'desktop', isInteractive: true })

  const answer = await $.command.run(typed('cl'))
  expect(answer.text).toContain('4 files')
  expect(answer.text).toContain('+5 -2')

  const [run] = diffRuns(repo)
  expect(run?.cwd).toBe('/ws/main')
  expect(run?.argv.slice(-4)).toEqual(['--from', 'trunk()', '--to', '@'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /trunk\(\)/ }))?.text).toContain('trunk() → @')
    expect((await ui.find({ key: 'file:src/app.ts' }))?.text).toContain('src/app.ts')
    expect((await ui.find({ key: 'file:src/app.ts' }))?.text).toContain('+2')
    expect((await ui.find({ key: 'file:gone.txt' }))?.text).toContain('old.txt → gone.txt')
    expect((await ui.find({ type: 'Text', text: /^\+const c = 4$/ }))?.text).toBe('+const c = 4')
    expect((await ui.find({ type: 'Text', text: /^\/ws\/main$/ }))?.text).toBe('/ws/main')
    await ui.unmount()
  }
})

test('a change id goes to jj diff -r', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('rev kxwqplmn'))
  expect(diffRuns(repo)[0]?.argv.slice(-2)).toEqual(['-r', 'kxwqplmn'])
})

test('an edit in a secondary workspace without .git follows jj root there', async ($, on) => {
  const repo: Repo = {
    roots: { '/ws/main': '/ws/main', '/ws/feature': '/ws/feature' },
    diff: SAMPLE,
    runs: [],
  }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.command.run(typed(''))
  expect(diffRuns(repo)[0]?.cwd).toBe('/ws/main')

  await $.tool.call({
    tool: 'Edit',
    file_path: '/ws/feature/src/lib.rs',
    old_string: 'a',
    new_string: 'b',
  })
  const rootRuns = repo.runs.filter(run => run.argv.includes('root'))
  expect(rootRuns.some(run => run.cwd === '/ws/feature/src')).toBe(true)
  const last = diffRuns(repo).at(-1)
  expect(last?.cwd).toBe('/ws/feature')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/ws\/feature/ }))?.text).toBe('/ws/feature (followed)')
  await ui.unmount()
})

test('an explicit path wins over followed edits', async ($, on) => {
  const repo: Repo = {
    roots: { '/ws/main': '/ws/main', '/ws/feature': '/ws/feature' },
    diff: SAMPLE,
    runs: [],
  }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.command.run(typed('change /ws/main'))
  await $.tool.call({ tool: 'Write', file_path: '/ws/feature/x.txt', content: 'x' })
  expect(diffRuns(repo).every(run => run.cwd === '/ws/main')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /\/ws\/main/ }))?.text).toBe('/ws/main (pinned)')
  await ui.unmount()
})

test('outside any jj repo the pane says so', async ($, on) => {
  const repo: Repo = { roots: {}, diff: '', runs: [] }
  fakeJj(on, repo, '/elsewhere')
  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  const answer = await $.command.run(typed(''))
  expect(answer.text).toContain('Not a jj repo: /elsewhere')
  expect(diffRuns(repo)).toHaveLength(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Not a jj repo/ }))?.text).toBe('Not a jj repo: /elsewhere')
    await ui.unmount()
  }
})

test('the pane refreshes after an Edit, a Bash call and the refresh button', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  fakeJj(on, repo, '/ws/main')
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.command.run(typed(''))
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

  await ui.press({ key: 'mode-cl' })
  expect(diffRuns(repo).at(-1)?.argv).toContain('trunk()')

  await ui.press({ key: 'file:src/app.ts' })
  expect(await ui.find({ type: 'Text', text: /^\+const c = 4$/ })).toBeUndefined()
  expect((await ui.find({ key: 'file:src/app.ts' }))?.text).toContain('▸')
  await ui.unmount()
})

test('a tool call is not refreshed while the pane is closed', async ($, on) => {
  const repo: Repo = { roots: { '/ws/main': '/ws/main' }, diff: '', runs: [] }
  on('session.cwd', () => ({ value: '/ws/main' }))
  on('command.register', () => ({ value: { command: 'jj-diff' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', (_, e) => {
    repo.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/ws/main', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/ws/main/a', old_string: 'a', new_string: 'b' })
  expect(repo.runs).toHaveLength(0)
})
