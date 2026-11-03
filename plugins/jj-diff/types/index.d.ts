export type DiffLineKind = 'add' | 'del' | 'ctx' | 'meta'
export type DiffLine = { kind: DiffLineKind; text: string }
export type DiffHunk = { header: string; lines: DiffLine[] }
export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'
export type DiffFile = {
  path: string
  oldPath?: string
  status: FileStatus
  added: number
  removed: number
  hunks: DiffHunk[]
}

export type DiffView = {
  chosenRoot: string | null
  root: string | null
  candidates: string[]
  error: string | null
  files: DiffFile[]
  isLoading: boolean
  updatedAt: number | null
  collapsed: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'jj-diff': { view: Shaped<DiffView> }
  }
}
