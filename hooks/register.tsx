import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ci, Job, Run } from '../types'
import { layout, toState } from './layout'
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

const COLOR: Partial<Record<Tone, string>> = { ok: 'success', fail: 'error', run: 'warning' }
const DIM: Tone[] = ['wait', 'skip', 'stop', 'dim']

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
  const runs: Run[] = await Promise.all(
    picked.map(async run => ({
      id: run.databaseId,
      name: run.workflowName.replace(/^\d+\.\s*/, ''),
      state: toState(run.status, run.conclusion),
      jobs: await jobsOf($, run),
    })),
  )

  return { sha, isHead: sha === head, runs }
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
    isActive = next?.runs.some(run => run.state === 'run' || run.state === 'wait') ?? false

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
