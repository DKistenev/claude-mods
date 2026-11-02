import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DiffFile, DiffMode, DiffView } from '../types'
import {
  baseName,
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
const ROOT_TIMEOUT_MS = 15_000
const DIFF_TIMEOUT_MS = 60_000
const MAX_LINES_PER_FILE = 400
const MAX_LINES_TOTAL = 3000

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

async function jjRoot($: EngineInterface, dir: string): Promise<Resolved> {
  try {
    const ran = await $.process.run(rootArgv(), { cwd: dir, timeoutMs: ROOT_TIMEOUT_MS })
    if (ran.exitCode === 0 && ran.stdout.trim() !== '') return { root: ran.stdout.trim() }
    return { error: describeRootFailure(ran.stderr, dir) }
  } catch (failure) {
    return { error: `jj could not run in ${dir}: ${String(failure)}` }
  }
}

async function resolveRoot($: EngineInterface, v: DiffView): Promise<Resolved> {
  if (v.explicitRoot !== null) return jjRoot($, v.explicitRoot)
  if (v.followedRoot !== null) return { root: v.followedRoot }
  return jjRoot($, await $.session.cwd())
}

let isRefreshing = false
let isRefreshPending = false

async function refreshOnce($: EngineInterface): Promise<void> {
  const before = await read($, view)
  await update($, view, v => ({ ...v, isLoading: true }))
  const where = await resolveRoot($, before)
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
      timeoutMs: DIFF_TIMEOUT_MS,
    })
    if (ran.exitCode === 0) {
      files = parseDiff(ran.stdout)
      if (ran.isStdoutTruncated) error = 'Diff is larger than 4 MiB; showing the first part only.'
    } else {
      error = ran.stderr.trim().split('\n')[0] ?? `jj diff exited with ${ran.exitCode}`
    }
  } catch (failure) {
    error = `jj diff could not run: ${String(failure)}`
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

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isRefreshPending = true
    return
  }
  isRefreshing = true
  try {
    do {
      isRefreshPending = false
      await refreshOnce($)
    } while (isRefreshPending)
  } finally {
    isRefreshing = false
  }
}

async function isOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

function absolute(path: string, cwd: string): string {
  if (path.startsWith('/')) return path
  if (path === '~' || path.startsWith('~/')) return path
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\/+/, '')}`
}

function summary(v: DiffView): string {
  if (v.error !== null && v.root === null) return `jj diff: ${v.error}`
  const sum = totals(v.files)
  const count = v.files.length === 1 ? '1 file' : `${v.files.length} files`
  const where = v.root === null ? '' : ` in ${v.root}`
  return `jj diff pane opened: ${modeLabel(v.mode, v.rev)}, ${count}, +${sum.added} -${sum.removed}${where}`
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
      description: 'Open a pane with the jj diff: /jj-diff [change|cl|rev <id>] [path]',
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
    await update($, view, v => ({
      ...v,
      mode: request.mode,
      rev: request.rev,
      explicitRoot: request.path === null ? null : absolute(request.path, cwd),
      collapsed: [],
    }))
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
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
      if (edited !== null && typeof edited === 'string') {
        const found = await jjRoot($, dirOf(edited))
        if (found.root !== undefined) {
          await update($, view, v =>
            v.followedRoot === found.root ? v : { ...v, followedRoot: found.root },
          )
        }
      }
      await refresh($)
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
      await refresh($)
    }
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
          <Button key="refresh" hotkey="r" onPress={() => refresh($)}>
            {v.isLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Box>
        {v.root !== null && (
          <Text dimColor wrap="truncate-start">
            {v.root}
            {v.explicitRoot !== null ? ' (pinned)' : v.followedRoot !== null ? ' (followed)' : ''}
          </Text>
        )}
        {v.error !== null && <Text color="error">{v.error}</Text>}
        {v.root !== null && v.error === null && v.files.length === 0 && (
          <Text dimColor>{v.updatedAt === null ? 'Loading…' : 'No changes.'}</Text>
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
