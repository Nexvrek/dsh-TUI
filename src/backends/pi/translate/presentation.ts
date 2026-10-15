/**
 * pi tool presentations: which card shape each pi tool call and result
 * renders as, in the backend-neutral `ToolPresentation` vocabulary. The UI
 * never picks a card by tool name; this table does, from the tool arguments
 * and the result pi recorded (`content`, tool-specific `details`).
 *
 * pi's built-in tools: `read {path, offset?, limit?}`, `write {path, content}`,
 * `edit {path, edits: [{oldText, newText}]}` (result `details.patch` is a
 * unified diff), `bash {command, timeout?}` (a non-zero exit is an error
 * result ending in `Command exited with code N`), `grep {pattern, path?, …}`
 * (`path:line: text` rows), `find {pattern, path?}` (one path per row) and
 * `ls {path?}`; `powershell` is bash's shape on Windows. Extension and MCP
 * tools fall back to the plain card. Every reader narrows `unknown`:
 * arguments come from the model.
 */
import { displayPath } from '../../shared/display-path.js'
import type { ToolFileDiff } from '../../../agent/index.js'
import type { ToolCallPresentation, ToolPresentationMeta, ToolResultPresentation } from '../../../agent/presentation.js'
import { arr, num, rec, str, type Rec } from '../narrow.js'

const META: Readonly<Record<string, ToolPresentationMeta>> = {
  read: { displayKey: 'tool-name-read', category: 'other' },
  write: { displayKey: 'tool-name-write', category: 'mutate' },
  edit: { displayKey: 'tool-name-edit', category: 'mutate' },
  bash: { displayKey: 'tool-name-bash', category: 'exec' },
  powershell: { displayKey: 'tool-name-powershell', category: 'exec' },
  grep: { displayKey: 'tool-name-grep', category: 'other' },
  find: { displayKey: 'tool-name-glob', category: 'other' },
  ls: { category: 'other' },
}
const metaOf = (name: string): ToolPresentationMeta => (Object.hasOwn(META, name) ? META[name] : undefined) ?? { category: 'other' }

/** The `edits` of an edit call: the array form, a JSON-string array (some
 *  models send one), a single edit object, or the legacy top-level pair. */
export function editsOf(input: Rec): { readonly oldText: string; readonly newText: string }[] {
  let raw: unknown = input.edits
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { raw = undefined }
  }
  const list = Array.isArray(raw) ? raw : rec(raw) !== undefined ? [raw] : []
  const edits = list.flatMap(item => {
    const edit = rec(item)
    const from = str(edit?.oldText)
    const to = str(edit?.newText)
    return from === undefined || to === undefined ? [] : [{ oldText: from, newText: to }]
  })
  if (edits.length > 0) return edits
  const from = str(input.oldText)
  const to = str(input.newText)
  return from === undefined || to === undefined ? [] : [{ oldText: from, newText: to }]
}

/** How a call renders while it runs (undefined = the plain card). */
export function presentPiToolCall(name: string, rawInput: unknown, cwd: string): ToolCallPresentation | undefined {
  const input = rec(rawInput) ?? {}
  const meta = metaOf(name)
  const path = str(input.path)
  switch (name) {
    case 'read': {
      if (path === undefined) return undefined
      const offset = num(input.offset)
      return { card: 'generic', title: `${displayPath(path, cwd)}${offset === undefined ? '' : `:${offset}`}`, ...meta }
    }
    case 'write': {
      const content = str(input.content)
      if (path === undefined || content === undefined) return undefined
      return { card: 'diff', title: displayPath(path, cwd), diffs: [{ path, oldText: null, newText: content }], ...meta }
    }
    case 'edit': {
      if (path === undefined) return undefined
      const edits = editsOf(input)
      if (edits.length === 0) return { card: 'generic', title: displayPath(path, cwd), ...meta }
      return { card: 'diff', title: displayPath(path, cwd), diffs: edits.map(edit => ({ path, oldText: edit.oldText, newText: edit.newText })), ...meta }
    }
    case 'bash':
    case 'powershell': {
      const command = str(input.command)
      if (command === undefined) return undefined
      return { card: 'terminal', title: command, cwd, ...meta }
    }
    case 'grep':
    case 'find': {
      const pattern = str(input.pattern)
      if (pattern === undefined) return undefined
      return { card: 'generic', title: path === undefined ? pattern : `${pattern} · ${displayPath(path, cwd)}`, ...meta }
    }
    case 'ls':
      return { card: 'generic', title: displayPath(path ?? '.', cwd), ...meta }
    default:
      return undefined
  }
}

/** The settled facts of one tool result. */
export interface PiToolOutcome {
  readonly isError: boolean
  /** The result's text blocks joined. */
  readonly text: string
  /** pi's tool-specific `details`. */
  readonly details: unknown
}

const EXIT_STATUS = /(?:^|\n\n)Command exited with code (-?\d+)$/u

/** Rows of a pi grep result (`path:line: text`). */
function grepFiles(content: string): { path: string; matches: { lineNumber: number; line: string }[] }[] {
  const files = new Map<string, { lineNumber: number; line: string }[]>()
  for (const raw of content.split('\n')) {
    const match = /^(.+?):(\d+): (.*)$/u.exec(raw)
    if (match === null) continue
    const list = files.get(match[1]!) ?? []
    list.push({ lineNumber: Number(match[2]), line: match[3]! })
    files.set(match[1]!, list)
  }
  return [...files].map(([path, matches]) => ({ path, matches }))
}

/** How a settled result renders (undefined = the plain text card). */
export function presentPiToolResult(name: string, rawInput: unknown, outcome: PiToolOutcome, cwd: string): ToolResultPresentation | undefined {
  const input = rec(rawInput) ?? {}
  const meta = metaOf(name)
  const details = rec(outcome.details)
  const path = str(input.path)
  if (name === 'bash' || name === 'powershell') {
    // A failing command is still a terminal: its output and exit status.
    const status = EXIT_STATUS.exec(outcome.text)
    if (outcome.isError && status === null) return undefined
    const output = status === null ? outcome.text : outcome.text.slice(0, status.index)
    return { card: 'terminal', title: str(input.command), output, ...(status === null ? { exitCode: 0 } : { exitCode: Number(status[1]) }), ...meta }
  }
  if (outcome.isError) return undefined
  switch (name) {
    case 'read':
      return path === undefined ? undefined : { card: 'read', title: displayPath(path, cwd), path, content: [{ type: 'text', text: outcome.text }], ...meta }
    case 'write': {
      const content = str(input.content)
      if (path === undefined || content === undefined) return undefined
      return { card: 'diff', title: displayPath(path, cwd), diffs: [{ path, oldText: null, newText: content }], ...meta }
    }
    case 'edit': {
      if (path === undefined) return undefined
      const patch = str(details?.patch)
      const diffs: ToolFileDiff[] = patch !== undefined && patch !== ''
        ? [{ path, patch, change: 'update' }]
        : editsOf(input).map(edit => ({ path, oldText: edit.oldText, newText: edit.newText }))
      return diffs.length === 0 ? undefined : { card: 'diff', title: displayPath(path, cwd), diffs, ...meta }
    }
    case 'grep': {
      const files = grepFiles(outcome.text)
      if (files.length === 0) return undefined
      const total = files.reduce((sum, file) => sum + file.matches.length, 0)
      const truncated = details?.matchLimitReached !== undefined || rec(details?.truncation)?.truncated === true || details?.linesTruncated === true
      return { card: 'search', shape: 'matches', title: str(input.pattern), files, truncated, total, ...meta }
    }
    case 'find': {
      const paths = outcome.text.split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('['))
      if (paths.length === 0) return undefined
      const truncated = details?.resultLimitReached !== undefined || rec(details?.truncation)?.truncated === true
      return { card: 'search', shape: 'paths', title: str(input.pattern), paths, truncated, total: paths.length, ...meta }
    }
    default:
      return undefined
  }
}

/** The text blocks of a tool result's content, joined (images skipped). */
export function resultText(content: unknown): string {
  return arr(content).map(rec).filter(block => block?.type === 'text').map(block => str(block!.text) ?? '').join('\n')
}
