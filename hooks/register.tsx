import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ci, Job, Run } from '../types'
import { layout, statusState, toState } from './layout'
import type { Tone } from './layout'

const TICK_MS = 15_000
const IDLE_MS = 120_000
const HOT_MS = 180_000

const ci = atom({ plugin: 'ci-line', key: 'ci' } as const, null)
const isExpanded = atom({ plugin: 'ci-line', key: 'isExpanded' } as const, false)

type GhRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  run_attempt: number
  created_at: string
}
type GhJob = { name: string; status: string; conclusion: string | null }
type GhCheck = GhJob & { app: { slug: string } | null }
type GhStatus = { context: string; state: string }

const COLOR: Partial<Record<Tone, string>> = { ok: 'success', fail: 'error', run: 'warning', wait: 'warning' }
const DIM: Tone[] = ['skip', 'stop', 'dim']

let isFetching = false
let isActive = false
let fetchedAt = 0
let hotUntil = 0
let lastKey = ''
let lastJson = ''
const doneJobs = new Map<string, Job[]>()

// Throws when gh fails, so a failed read keeps the line as it was instead of drawing it green.
const gh = async <T,>($: EngineInterface, argv: string[]): Promise<T> => {
  const ran = await $.process.run(['gh', ...argv])
  if (ran.exitCode !== 0) throw new Error(ran.stderr)

  return JSON.parse(ran.stdout) as T
}

const jobsOf = async ($: EngineInterface, run: GhRun): Promise<Job[]> => {
  const attempt = `${run.id}:${run.run_attempt}`
  const kept = doneJobs.get(attempt)
  if (kept !== undefined) return kept

  const view = await gh<{ jobs: GhJob[] }>($, ['run', 'view', String(run.id), '--json', 'jobs'])
  const jobs = view.jobs.map(job => ({ name: job.name, state: toState(job.status, job.conclusion) }))
  if (run.status === 'completed') doneJobs.set(attempt, jobs)

  return jobs
}

// Everything that reports on one commit: its workflow runs, whatever branch or event
// started them, then other apps' check runs and commit statuses.
const runsOf = async ($: EngineInterface, sha: string): Promise<Run[]> => {
  const commit = `repos/{owner}/{repo}/commits/${sha}`
  const [actions, checks, combined] = await Promise.all([
    gh<{ workflow_runs: GhRun[] }>($, ['api', `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=100`]),
    gh<{ check_runs: GhCheck[] }>($, ['api', `${commit}/check-runs?per_page=100`]),
    gh<{ statuses: GhStatus[] }>($, ['api', `${commit}/status?per_page=100`]),
  ])
  const latest = new Map<string, GhRun>()
  for (const run of actions.workflow_runs) {
    if (!latest.has(run.name)) latest.set(run.name, run)
  }
  const picked = [...latest.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const workflows = await Promise.all(
    picked.map(async run => ({
      id: run.id,
      name: run.name.replace(/^\d+\.\s*/, ''),
      state: toState(run.status, run.conclusion),
      jobs: await jobsOf($, run),
    })),
  )
  const foreign = checks.check_runs.filter(check => check.app?.slug !== 'github-actions')

  return [
    ...workflows,
    ...foreign.map(check => ({ id: 0, name: check.name, state: toState(check.status, check.conclusion), jobs: [] })),
    ...combined.statuses.map(one => ({ id: 0, name: one.context, state: statusState(one.state), jobs: [] })),
  ]
}

// HEAD's CI when it has any; otherwise the last pushed commit's, marked as not HEAD.
const load = async ($: EngineInterface, head: string, pushed: string): Promise<Ci | null> => {
  const own = await runsOf($, head)
  if (own.length > 0) return { sha: head, isHead: true, runs: own }
  if (pushed === '' || pushed === head) return null

  const runs = await runsOf($, pushed)

  return runs.length > 0 ? { sha: pushed, isHead: false, runs } : null
}

const refresh = async ($: EngineInterface, isForced = false) => {
  if (isFetching) return
  isFetching = true
  try {
    const git = await $.process.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])
    const [head = '', branch = ''] = git.stdout.trim().split('\n')
    const upstream = await $.process.run(['git', 'rev-parse', '--verify', '-q', '@{u}'])
    const pushed = upstream.exitCode === 0 ? upstream.stdout.trim() : ''
    const key = git.exitCode === 0 && branch !== 'HEAD' ? `${branch}@${head}@${pushed}` : ''
    const now = await $.clock.now()
    // A new commit or push: its runs take a while to appear, so keep polling fast for them.
    if (key !== lastKey) hotUntil = now + HOT_MS
    const isDue = isForced || key !== lastKey || isActive || now < hotUntil || now - fetchedAt >= IDLE_MS
    if (!isDue) return

    lastKey = key
    fetchedAt = now
    const next = key === '' ? null : await load($, head, pushed)
    isActive = next?.runs.some(run => run.id !== 0 && (run.state === 'run' || run.state === 'wait')) ?? false
    if (next?.isHead === true && next.runs.some(run => run.id !== 0)) hotUntil = 0

    const json = JSON.stringify(next)
    if (json !== lastJson) {
      lastJson = json
      await update($, ci, () => next)
    }
  } catch {
    // gh missing, offline, not a GitHub repo: keep what is shown and try again later.
  } finally {
    isFetching = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci',
      description: 'Refresh the CI line and toggle its jobs open or closed',
    })
    $.clock.every(TICK_MS, () => void refresh($))
    void refresh($, true)

    return next(e)
  })

  on('command.run', { command: 'ci' }, async $ => {
    const isOpen = await update($, isExpanded, was => !was)
    await refresh($, true)

    return { text: isOpen ? 'CI line: jobs shown.' : 'CI line: jobs shown only while running or failed.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b|\bgh\s+(pr|run|workflow)\b/.test(e.command)) {
      hotUntil = (await $.clock.now()) + HOT_MS
      $.clock.after(5_000, () => void refresh($, true))
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, ci)
    if (e.props.hasSurvey || state === null || state.runs.length === 0) {
      return next(e)
    }

    const isOpen = await read($, isExpanded)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isClickable = e.viewport?.isFullscreen === true
    const columns = (e.props.bodyColumns ?? e.viewport?.columns ?? 200) - (isClickable ? 3 : 19)

    return (
      <Box flexDirection="column">
        {layout(state, isOpen, columns).map((row, at) => (
          <Box>
            <Text wrap="truncate-end">
              {row.map(seg => (
                <Text color={COLOR[seg.tone]} dimColor={DIM.includes(seg.tone)}>
                  {seg.text}
                </Text>
              ))}
            </Text>
            {at === 0 && (
              <Button
                key="toggle"
                plain
                label={isOpen ? ' ▾' : ' ▸'}
                onPress={() => update($, isExpanded, was => !was)}
              />
            )}
            {at === 0 && !isClickable && <Text dimColor> /ci to {isOpen ? 'collapse' : 'expand'}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
