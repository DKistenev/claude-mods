import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffFile, DiffView } from '../types'
import { STACK, describeRootFailure, diffArgv, dirOf, parseDiff, rootArgv, totals } from './diff'

const PANE = 'jj-diff'
const TITLE = 'jj diff'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const REFRESH_TOOLS = new Set([...EDIT_TOOLS, 'Bash'])
const MAX_CODE_CHARS = 90_000

type Limits = { rootMs: number; diffMs: number }
const ASKED: Limits = { rootMs: 15_000, diffMs: 60_000 }
const QUICK: Limits = { rootMs: 5_000, diffMs: 8_000 }

const INITIAL: DiffView = {
  chosenRoot: null,
  root: null,
  candidates: [],
  error: null,
  files: [],
  isLoading: false,
  updatedAt: null,
  collapsed: [],
}

const view = atom({ plugin: 'jj-diff', key: 'view' } as const, INITIAL, { shape: 'view-2' })

type Resolved = { root: string; error?: undefined } | { root?: undefined; error: string }

const knownRoots = new Map<string, string>()

async function jjRoot($: EngineInterface, dir: string, limits: Limits): Promise<Resolved> {
  const known = knownRoots.get(dir)
  if (known !== undefined) return { root: known }
  try {
    const ran = await $.process.run(rootArgv(), { cwd: dir, timeoutMs: limits.rootMs })
    if (ran.exitCode === 0 && ran.stdout.trim() !== '') {
      const root = ran.stdout.trim()
      knownRoots.set(dir, root)
      return { root }
    }
    return { error: describeRootFailure(ran.stderr, dir) }
  } catch (failure) {
    return { error: `jj could not run in ${dir}: ${String(failure)}` }
  }
}

function forgetRoot(root: string): void {
  for (const [dir, known] of knownRoots) if (known === root) knownRoots.delete(dir)
}

async function childRepos($: EngineInterface, cwd: string): Promise<string[]> {
  try {
    const entries = await $.fs.list(cwd)
    const dirs = entries.filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.'))
    const base = cwd.replace(/\/+$/, '')
    const found: string[] = []
    for (const entry of dirs) {
      const path = `${base}/${entry.name}`
      if (await $.fs.exists(`${path}/.jj`)) found.push(path)
    }
    return found.sort()
  } catch {
    return []
  }
}

async function discover($: EngineInterface, limits: Limits): Promise<void> {
  const cwd = await $.session.cwd()
  const own = await jjRoot($, cwd, limits)
  const children = own.root === undefined ? await childRepos($, cwd) : []
  await update($, view, v => {
    const candidates = [
      ...new Set([
        ...(v.chosenRoot !== null ? [v.chosenRoot] : []),
        ...(own.root !== undefined ? [own.root] : []),
        ...children,
      ]),
    ]
    const chosenRoot = v.chosenRoot ?? (own.root === undefined ? (children[0] ?? null) : null)
    return { ...v, candidates, chosenRoot }
  })
}

async function resolveRoot($: EngineInterface, v: DiffView, limits: Limits): Promise<Resolved> {
  if (v.chosenRoot !== null) return { root: v.chosenRoot }
  return jjRoot($, await $.session.cwd(), limits)
}

function firstLine(text: string): string | null {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line === '' ? null : line
}

let isRefreshing = false
let isRefreshPending = false
let pendingLimits: Limits = QUICK

async function refreshOnce($: EngineInterface, limits: Limits): Promise<void> {
  const before = await read($, view)
  await update($, view, v => ({ ...v, isLoading: true }))
  const where = await resolveRoot($, before, limits)
  if (where.root === undefined) {
    await update($, view, v => ({
      ...v,
      root: null,
      error: where.error,
      files: [],
      isLoading: false,
      updatedAt: Date.now(),
    }))
    return
  }
  const root = where.root
  let files: DiffFile[] = []
  let error: string | null = null
  try {
    const ran = await $.process.run(diffArgv(), { cwd: root, timeoutMs: limits.diffMs })
    if (ran.exitCode === 0) {
      files = parseDiff(ran.stdout)
      if (ran.isStdoutTruncated) error = 'Diff is larger than 4 MiB; showing the first part only.'
    } else {
      error = firstLine(ran.stderr) ?? `jj diff exited with code ${ran.exitCode}`
      forgetRoot(root)
    }
  } catch (failure) {
    error = `jj diff could not run: ${String(failure)}`
    forgetRoot(root)
  }
  await update($, view, v => ({
    ...v,
    root,
    error,
    files,
    isLoading: false,
    updatedAt: Date.now(),
  }))
}

async function refresh($: EngineInterface, limits: Limits): Promise<void> {
  if (isRefreshing) {
    isRefreshPending = true
    if (limits.diffMs > pendingLimits.diffMs) pendingLimits = limits
    return
  }
  isRefreshing = true
  let next = limits
  try {
    do {
      isRefreshPending = false
      pendingLimits = QUICK
      await refreshOnce($, next)
      next = pendingLimits
    } while (isRefreshPending)
  } finally {
    isRefreshing = false
  }
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function togglePane($: EngineInterface): Promise<void> {
  if (await isOpen($)) {
    await $.ui.close({ id: PANE })
    return
  }
  await $.ui.open({ id: PANE, title: TITLE })
  await discover($, ASKED)
  await refresh($, ASKED)
}

function absolute(path: string, cwd: string): string {
  if (path.startsWith('/')) return path
  const base = cwd.replace(/\/+$/, '')
  const rest = path.replace(/^\.\/+/, '')
  return rest === '' || rest === '.' ? base : `${base}/${rest}`
}

function nameOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

function statusAside(file: DiffFile): string {
  if (file.status === 'added') return ' (new)'
  if (file.status === 'deleted') return ' (deleted)'
  if (file.status === 'binary') return ' (binary)'
  return ''
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`
}

const HUNK_HEADER = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/

function fileSource(file: DiffFile): string {
  return file.hunks
    .map(hunk => [HUNK_HEADER.exec(hunk.header)?.[1] ?? hunk.header, ...hunk.lines.map(line => line.text)].join('\n'))
    .join('\n')
}

function displayPath(file: DiffFile): string {
  return file.oldPath !== undefined ? `${file.oldPath} → ${file.path}` : file.path
}

export const register: Register = on => {
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="jj-diff-toggle" plain dimColor onPress={() => togglePane($)}>
          jj diff
        </Button>
        {below}
      </Box>
    )
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!REFRESH_TOOLS.has(e.tool)) return ran
    try {
      if (!(await isOpen($))) return ran
      const edited =
        e.tool === 'Edit' || e.tool === 'Write'
          ? e.file_path
          : e.tool === 'NotebookEdit'
            ? e.notebook_path
            : null
      if (edited !== null && typeof edited === 'string' && edited !== '') {
        const dir = absolute(dirOf(edited), await $.session.cwd())
        const found = await jjRoot($, dir, QUICK)
        if (found.root !== undefined) {
          const root = found.root
          await update($, view, v =>
            v.chosenRoot === root
              ? v
              : {
                  ...v,
                  chosenRoot: root,
                  candidates: v.candidates.includes(root) ? v.candidates : [...v.candidates, root].sort(),
                },
          )
        }
      }
      await refresh($, QUICK)
    } catch (failure) {
      $.ui.log(`jj-diff: refresh after ${e.tool} failed: ${String(failure)}`, { to: 'debug' })
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    const Select = 'Select' in elements ? elements.Select : undefined
    const v = await read($, view)
    const sum = totals(v.files)
    const collapsed = new Set(v.collapsed)
    const columns = Math.max(1, e.props.bodyColumns - 1)
    const stat = (added: number, removed: number) => (
      <Text>
        {added > 0 ? <Text color="diffAddedWord">{`+${added}`}</Text> : ''}
        {added > 0 && removed > 0 ? ' ' : ''}
        {removed > 0 ? <Text color="diffRemovedWord">{`-${removed}`}</Text> : ''}
      </Text>
    )
    const toggle = (path: string) => () =>
      update($, view, cur => ({
        ...cur,
        collapsed: cur.collapsed.includes(path)
          ? cur.collapsed.filter(p => p !== path)
          : [...cur.collapsed, path],
      }))
    const chooseRoot = async (root: string) => {
      await update($, view, cur => ({ ...cur, chosenRoot: root, collapsed: [] }))
      await refresh($, ASKED)
    }
    const isSettled = v.updatedAt !== null && !v.isLoading
    const options = v.candidates.map(root => ({ value: root, label: nameOf(root) }))
    const hasChoice = Select !== undefined && options.length > 1 && v.root !== null
    let room = MAX_CODE_CHARS
    let withheld = 0

    const bodies = v.files.map(file => {
      const isCollapsed = collapsed.has(file.path)
      const source = fileSource(file)
      const size = source.length
      const fits = size <= room
      if (!isCollapsed && fits) room -= size
      if (!isCollapsed && !fits) withheld += 1
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Button key={`file:${file.path}`} plain onPress={toggle(file.path)}>
              {`${isCollapsed ? '▸' : '▾'} ${displayPath(file)}`}
            </Button>
            <Text dimColor>{statusAside(file)}</Text>
            <Box flexGrow={1} />
            {stat(file.added, file.removed)}
          </Box>
          {isCollapsed ? null : file.hunks.length === 0 ? (
            <Text dimColor>No text changes.</Text>
          ) : fits ? (
            <Code source={source} format="diff" path={file.path} wrap="truncate-end" />
          ) : (
            <Text dimColor>Too large to draw here; run jj diff in a terminal.</Text>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {v.files.length > 0 ? (
            <Text wrap="truncate-end">
              <Text bold>{plural(v.files.length, 'file')}</Text>
              {' changed '}
              {stat(sum.added, sum.removed)}
            </Text>
          ) : (
            <Text bold>jj diff</Text>
          )}
          <Box flexGrow={1} />
          {hasChoice && Select !== undefined ? (
            <Select key="repo" label="repo" options={options} value={v.root ?? undefined} onSelect={chooseRoot} />
          ) : null}
          <Button key="refresh" plain onPress={() => refresh($, ASKED)}>
            {v.isLoading ? '↻ …' : '↻'}
          </Button>
        </Box>
        {v.root !== null && (
          <Text dimColor wrap="truncate-start">
            {`${STACK} · ${v.root}`}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(columns)}
        </Text>
        {!isSettled && <Text dimColor>Loading…</Text>}
        {v.error !== null && <Text color="error">{v.error}</Text>}
        {isSettled && v.root === null && (
          <Text dimColor>The pane follows the next file Claude edits in a jj repo.</Text>
        )}
        {isSettled && v.root !== null && v.error === null && v.files.length === 0 && (
          <Text dimColor>No changes.</Text>
        )}
        {bodies}
        {withheld > 0 && <Text dimColor>{`${plural(withheld, 'file')} not drawn: the pane's limit was reached.`}</Text>}
      </Box>
    )
  })
}
