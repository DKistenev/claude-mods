import type { DiffFile, DiffHunk, DiffLine, FileStatus } from '../types'

const BASE = ['jj', '--no-pager', '--color', 'never', '--quiet']

export const STACK = 'trunk()..@'

export function rootArgv(): string[] {
  return [...BASE, 'root']
}

export function diffArgv(): string[] {
  return [...BASE, 'diff', '--git', '-r', STACK]
}

export function describeRootFailure(stderr: string, dir: string): string {
  const line = stderr.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
  if (/no jj repo/i.test(line) || line === '') return `Not a jj repo: ${dir}`
  return line.replace(/^Error:\s*/, '')
}

function stripPrefix(name: string): string {
  return name.replace(/^[ab]\//, '')
}

function headerPaths(line: string): { oldPath: string; newPath: string } | null {
  const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line)
  if (!m) return null
  return { oldPath: m[1] ?? '', newPath: m[2] ?? '' }
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let status: FileStatus = 'modified'
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const finish = () => {
    if (file !== null) {
      file.status = status
      files.push(file)
    }
    file = null
    hunk = null
    status = 'modified'
  }

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('diff --git ')) {
      finish()
      const paths = headerPaths(line)
      const path = paths ? paths.newPath : stripPrefix(line.slice('diff --git '.length).split(' ').pop() ?? '')
      file = { path, status: 'modified', added: 0, removed: 0, hunks: [] }
      continue
    }
    if (file === null) continue
    if (hunk === null) {
      if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename from ')) {
        status = 'renamed'
        file.oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ')) {
        status = 'renamed'
        file.path = line.slice('rename to '.length)
      } else if (line.startsWith('Binary files')) status = 'binary'
      else if (line.startsWith('+++ ')) {
        const name = line.slice(4)
        if (name !== '/dev/null') file.path = stripPrefix(name)
      } else if (line.startsWith('--- ')) {
        const name = line.slice(4)
        if (name !== '/dev/null' && status === 'renamed') file.oldPath = stripPrefix(name)
      }
    }
    if (line.startsWith('@@')) {
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    let kind: DiffLine['kind'] = 'ctx'
    if (line.startsWith('+')) {
      kind = 'add'
      file.added += 1
    } else if (line.startsWith('-')) {
      kind = 'del'
      file.removed += 1
    } else if (line.startsWith('\\')) kind = 'meta'
    hunk.lines.push({ kind, text: line })
  }
  finish()
  return files
}

export function totals(files: readonly DiffFile[]): { added: number; removed: number } {
  return files.reduce(
    (sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }),
    { added: 0, removed: 0 },
  )
}

export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  if (cut < 0) return '.'
  if (cut === 0) return '/'
  return path.slice(0, cut)
}
