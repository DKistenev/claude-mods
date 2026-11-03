import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffFile, DiffMode, DiffView } from '../types'
import {
  describeRootFailure,
  diffArgv,
  dirOf,
  modeLabel,
  parseArgs,
  parseDiff,
  rootArgv,
  totals,
} from './diff'

const PANE = 'jj-diff'
const TITLE = 'jj diff'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const REFRESH_TOOLS = new Set([...EDIT_TOOLS, 'Bash'])
const MAX_LINES_PER_FILE = 400
const MAX_LINES_TOTAL = 3000

type Limits = { rootMs: number; diffMs: number }
const ASKED: Limits = { rootMs: 15_000, diffMs: 60_000 }
const QUICK: Limits = { rootMs: 5_000, diffMs: 8_000 }

const INITIAL: DiffView = {
  mode: 'change',
  rev: null,
  explicitRoot: null,
  followedRoot: null,
  root: null,
  error: null,
  files: [],
  isLoading: false,
  updatedAt: null,
  collapsed: [],
}

const view = atom({ plugin: 'jj-diff', key: 'view' } as const, INITIAL, { shape: 'view-1' })

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

async function resolveRoot($: EngineInterface, v: DiffView, limits: Limits): Promise<Resolved> {
  if (v.explicitRoot !== null) return jjRoot($, v.explicitRoot, limits)
  if (v.followedRoot !== null) return { root: v.followedRoot }
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
    const ran = await $.process.run(diffArgv(before.mode, before.rev), {
      cwd: root,
      timeoutMs: limits.diffMs,
    })
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

function absolute(path: string, cwd: string, home: string | undefined): string {
  if (path.startsWith('/')) return path
  if (home !== undefined && (path === '~' || path.startsWith('~/'))) {
    return `${home.replace(/\/+$/, '')}${path.slice(1)}`
  }
  const base = cwd.replace(/\/+$/, '')
  const rest = path.replace(/^\.\/+/, '')
  return rest === '' || rest === '.' ? base : `${base}/${rest}`
}

function summary(v: DiffView): string {
  if (v.root === null) return `jj diff: ${v.error ?? 'nothing to show'}`
  const sum = totals(v.files)
  const count = v.files.length === 1 ? '1 file' : `${v.files.length} files`
  const head = `jj diff pane opened: ${modeLabel(v.mode, v.rev)}, ${count}, +${sum.added} -${sum.removed} in ${v.root}`
  return v.error === null ? head : `${head}. ${v.error}`
}

function lineColor(kind: DiffFile['hunks'][number]['lines'][number]['kind']): string | undefined {
  if (kind === 'add') return 'diffAdded'
  if (kind === 'del') return 'diffRemoved'
  if (kind === 'meta') return 'subtle'
  return undefined
}

function statusGlyph(file: DiffFile): string {
  if (file.status === 'added') return 'A'
  if (file.status === 'deleted') return 'D'
  if (file.status === 'renamed') return 'R'
  if (file.status === 'binary') return 'B'
  return 'M'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jj-diff',
      description: 'Open a pane with the jj diff: /jj-diff [change|cl|rev <id>] [path] | close',
    })
    return next(e)
  })

  on('command.run', { command: 'jj-diff' }, async ($, e) => {
    const word = e.args.trim()
    if (word === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'jj diff pane closed.' }
    }
    const request = parseArgs(e.args)
    if ('error' in request) return { text: `jj-diff: ${request.error}` }
    const cwd = await $.session.cwd()
    const home = request.path !== null && request.path.startsWith('~') ? await $.env.get('HOME') : undefined
    if (request.path !== null && request.path.startsWith('~') && home === undefined) {
      return { text: 'jj-diff: HOME is not set, so ~ cannot be expanded; give the full path.' }
    }
    await update($, view, v => ({
      ...v,
      mode: request.mode,
      rev: request.rev,
      explicitRoot: request.path === null ? null : absolute(request.path, cwd, home),
      followedRoot: null,
      collapsed: [],
    }))
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($, ASKED)
    return { text: summary(await read($, view)) }
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
        const dir = absolute(dirOf(edited), await $.session.cwd(), undefined)
        const found = await jjRoot($, dir, QUICK)
        if (found.root !== undefined) {
          await update($, view, v =>
            v.followedRoot === found.root ? v : { ...v, followedRoot: found.root },
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const sum = totals(v.files)
    const collapsed = new Set(v.collapsed)
    const toggle = (path: string) => () =>
      update($, view, cur => ({
        ...cur,
        collapsed: cur.collapsed.includes(path)
          ? cur.collapsed.filter(p => p !== path)
          : [...cur.collapsed, path],
      }))
    const setMode = (mode: DiffMode) => async () => {
      await update($, view, cur => ({ ...cur, mode, rev: mode === 'rev' ? cur.rev : null }))
      await refresh($, ASKED)
    }
    const isSettled = v.updatedAt !== null && !v.isLoading
    let budget = MAX_LINES_TOTAL

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>jj diff</Text>
          <Text dimColor>{modeLabel(v.mode, v.rev)}</Text>
          <Button key="mode-change" plain hotkey="c" onPress={setMode('change')}>
            {v.mode === 'change' ? '[change]' : 'change'}
          </Button>
          <Button key="mode-cl" plain hotkey="l" onPress={setMode('cl')}>
            {v.mode === 'cl' ? '[cl]' : 'cl'}
          </Button>
          <Button key="refresh" hotkey="r" onPress={() => refresh($, ASKED)}>
            {v.isLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Box>
        {v.root !== null && (
          <Text dimColor wrap="truncate-start">
            {v.root}
            {v.explicitRoot !== null ? ' (pinned)' : v.followedRoot !== null ? ' (followed)' : ''}
          </Text>
        )}
        {!isSettled && <Text dimColor>Loading…</Text>}
        {v.error !== null && <Text color="error">{v.error}</Text>}
        {isSettled && v.root !== null && v.error === null && v.files.length === 0 && (
          <Text dimColor>No changes.</Text>
        )}
        {v.files.length > 0 && (
          <Text dimColor>
            {v.files.length === 1 ? '1 file' : `${v.files.length} files`}, +{sum.added} -{sum.removed}
          </Text>
        )}
        {v.files.map(file => {
          const isCollapsed = collapsed.has(file.path)
          const rows: JSX.Element[] = []
          if (!isCollapsed) {
            let shown = 0
            let hidden = 0
            for (const hunk of file.hunks) {
              if (shown < MAX_LINES_PER_FILE && budget > 0) {
                rows.push(
                  <Text color="subtle" wrap="truncate-end">
                    {hunk.header}
                  </Text>,
                )
                shown += 1
                budget -= 1
              } else hidden += 1
              for (const line of hunk.lines) {
                if (shown >= MAX_LINES_PER_FILE || budget <= 0) {
                  hidden += 1
                  continue
                }
                rows.push(
                  <Text color={lineColor(line.kind)} wrap="truncate-end">
                    {line.text}
                  </Text>,
                )
                shown += 1
                budget -= 1
              }
            }
            if (hidden > 0) rows.push(<Text dimColor>… {hidden} more lines</Text>)
          }
          return (
            <Box flexDirection="column" marginTop={1}>
              <Button key={`file:${file.path}`} plain onPress={toggle(file.path)}>
                {isCollapsed ? '▸' : '▾'} {statusGlyph(file)}{' '}
                {file.oldPath !== undefined ? `${file.oldPath} → ` : ''}
                {file.path} <Text color="diffAdded">+{file.added}</Text>{' '}
                <Text color="diffRemoved">-{file.removed}</Text>
              </Button>
              {rows}
            </Box>
          )
        })}
      </Box>
    )
  })
}
