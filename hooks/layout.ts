import type { Ci, Job, Run, State } from '../types'

export type Tone = State | 'dim' | 'plain'
export type Seg = { text: string; tone: Tone }

const GLYPH: Record<State, string> = {
  ok: '●',
  fail: '✗',
  run: '◐',
  wait: '○',
  skip: '◌',
  stop: '⊘',
}

const isQuiet = (state: State) => state === 'ok' || state === 'skip'

export const toState = (status: string, conclusion: string | null): State => {
  if (status !== 'completed') return status === 'in_progress' ? 'run' : 'wait'
  if (conclusion === 'success') return 'ok'
  if (conclusion === 'skipped' || conclusion === 'neutral') return 'skip'
  if (conclusion === 'cancelled') return 'stop'

  return 'fail'
}

export const statusState = (state: string): State =>
  state === 'success' ? 'ok' : state === 'pending' ? 'wait' : 'fail'

// "lint / rubocop" -> group "lint", job "rubocop"; a job with no slash has no group.
const groupJobs = (jobs: Job[]): [string, Job[]][] => {
  const groups = new Map<string, Job[]>()
  for (const job of jobs) {
    const cut = job.name.indexOf(' / ')
    const label = cut === -1 ? '' : job.name.slice(0, cut)
    const name = cut === -1 ? job.name : job.name.slice(cut + 3)
    groups.set(label, [...(groups.get(label) ?? []), { ...job, name }])
  }

  return [...groups]
}

const rail = (rails: number[], width: number) =>
  Array.from({ length: width }, (_, at) => (rails.includes(at) ? '│' : ' ')).join('')

// First row: the line of checkpoints, one per workflow. Under it, right to left,
// each open workflow hangs its jobs from its own checkpoint.
// A line wider than the band drops the names of its green checkpoints, so the ones
// that need a look are never the part cut off.
export const layout = (ci: Ci, isExpanded: boolean, columns = Infinity): Seg[][] => {
  const line: Seg[] = [
    { text: 'CI ', tone: 'dim' },
    { text: ci.sha.slice(0, 7), tone: 'plain' },
    { text: ci.isHead ? '  ' : ' ≠HEAD  ', tone: 'dim' },
  ]
  let column = line.reduce((sum, seg) => sum + seg.text.length, 0)
  const full = ci.runs.reduce((sum, run) => sum + 2 + run.name.length, column + 4 * (ci.runs.length - 1))
  const label = (run: Run) => (full > columns && isQuiet(run.state) ? '' : ` ${run.name}`)
  const open: { column: number; run: Run }[] = []

  ci.runs.forEach((run, at) => {
    if (at > 0) {
      line.push({ text: ' ── ', tone: 'dim' })
      column += 4
    }
    if (run.jobs.length > 0 && (isExpanded || !isQuiet(run.state))) {
      open.push({ column, run })
    }
    line.push(
      { text: GLYPH[run.state], tone: run.state },
      { text: label(run), tone: isQuiet(run.state) ? 'dim' : 'plain' },
    )
    column += 1 + label(run).length
  })

  const rows = [line]
  for (let at = open.length - 1; at >= 0; at -= 1) {
    const { column: under, run } = open[at]!
    const rails = open.slice(0, at).map(one => one.column)
    const groups = groupJobs(run.jobs)

    groups.forEach(([label, jobs], g) => {
      const fork = g === groups.length - 1 ? '└─' : '├─'
      const row: Seg[] = [{ text: rail(rails, under) + fork, tone: 'dim' }]
      if (label !== '') row.push({ text: ` ${label}`, tone: 'plain' })
      for (const job of jobs) {
        const isNamed = isExpanded || !isQuiet(job.state)
        row.push({ text: ` ${GLYPH[job.state]}`, tone: job.state })
        if (isNamed) row.push({ text: ` ${job.name}`, tone: isQuiet(job.state) ? 'dim' : 'plain' })
      }
      rows.push(row)
    })
  }

  return rows
}
