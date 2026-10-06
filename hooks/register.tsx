import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ci, Job, Run } from '../types'
import { layout, statusState, toState } from './layout'
import type { Tone } from './layout'

const TICK_MS = 15_000
const IDLE_MS = 120_000

const ci = atom({ plugin: 'ci-line', key: 'ci' } as const, null)
const isExpanded = atom({ plugin: 'ci-line', key: 'isExpanded' } as const, false)

type GhRun = {
  databaseId: number
  workflowName: string
  status: string
  conclusion: string | null
  headSha: string
  createdAt: string
}
type GhJob = { name: string; status: string; conclusion: string | null }
type GhCheck = GhJob & { app: { slug: string } | null }
type GhStatus = { context: string; state: string }

const COLOR: Partial<Record<Tone, string>> = { ok: 'success', fail: 'error', run: 'warning', wait: 'warning' }
const DIM: Tone[] = ['skip', 'stop', 'dim']

let isFetching = false
let isActive = false
let fetchedAt = 0
let lastKey = ''
let lastJson = ''
const doneJobs = new Map<number, Job[]>()

const gh = async <T,>($: EngineInterface, argv: string[]): Promise<T | undefined> => {
  const ran = await $.process.run(['gh', ...argv])

  return ran.exitCode === 0 ? (JSON.parse(ran.stdout) as T) : undefined
}

const jobsOf = async ($: EngineInterface, run: GhRun): Promise<Job[]> => {
  const kept = doneJobs.get(run.databaseId)
  if (kept !== undefined) return kept

  const view = await gh<{ jobs: GhJob[] }>($, ['run', 'view', String(run.databaseId), '--json', 'jobs'])
  const jobs = (view?.jobs ?? []).map(job => ({ name: job.name, state: toState(job.status, job.conclusion) }))
  if (view !== undefined && run.status === 'completed') doneJobs.set(run.databaseId, jobs)

  return jobs
}

// What reports on the commit outside Actions: other apps' check runs and commit statuses.
const outsideOf = async ($: EngineInterface, sha: string): Promise<Run[]> => {
  const [checks, combined] = await Promise.all([
    gh<{ check_runs: GhCheck[] }>($, ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`]),
    gh<{ statuses: GhStatus[] }>($, ['api', `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`]),
  ])
  const foreign = (checks?.check_runs ?? []).filter(check => check.app?.slug !== 'github-actions')

  return [
    ...foreign.map(check => ({ id: 0, name: check.name, state: toState(check.status, check.conclusion), jobs: [] })),
    ...(combined?.statuses ?? []).map(one => ({ id: 0, name: one.context, state: statusState(one.state), jobs: [] })),
  ]
}

const load = async ($: EngineInterface, head: string, branch: string): Promise<Ci | null> => {
  const all = await gh<GhRun[]>($, [
    'run', 'list', '--branch', branch, '--limit', '20',
    '--json', 'databaseId,workflowName,status,conclusion,headSha,createdAt',
  ])
  const newest = all?.[0]
  if (all === undefined || newest === undefined) return null

  const sha = all.some(run => run.headSha === head) ? head : newest.headSha
  const latest = new Map<string, GhRun>()
  for (const run of all) {
    if (run.headSha === sha && !latest.has(run.workflowName)) latest.set(run.workflowName, run)
  }
  const picked = [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const [outside, ...runs] = await Promise.all([
    outsideOf($, sha),
    ...picked.map(async run => ({
      id: run.databaseId,
      name: run.workflowName.replace(/^\d+\.\s*/, ''),
      state: toState(run.status, run.conclusion),
      jobs: await jobsOf($, run),
    })),
  ])

  return { sha, isHead: sha === head, runs: [...runs, ...outside] }
}

const refresh = async ($: EngineInterface, isForced = false) => {
  if (isFetching) return
  isFetching = true
  try {
    const git = await $.process.run(['git', 'rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'])
    const [head = '', branch = ''] = git.stdout.trim().split('\n')
    const key = git.exitCode === 0 && branch !== 'HEAD' ? `${branch}@${head}` : ''
    const now = await $.clock.now()
    const isDue = isForced || key !== lastKey || isActive || now - fetchedAt >= IDLE_MS
    if (!isDue) return

    const next = key === '' ? null : await load($, head, branch)
    lastKey = key
    fetchedAt = now
    isActive = next?.runs.some(run => run.id !== 0 && (run.state === 'run' || run.state === 'wait')) ?? false

    const json = JSON.stringify(next)
    if (json !== lastJson) {
      lastJson = json
      await update($, ci, () => next)
    }
  } catch {
    // gh missing, offline, not a repo: keep what is shown and try again next tick.
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
      isActive = true
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

    return (
      <Box flexDirection="column">
        {layout(state, isOpen).map((row, at) => (
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
          </Box>
        ))}
      </Box>
    )
  })
}
