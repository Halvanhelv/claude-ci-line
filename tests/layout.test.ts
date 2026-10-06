import { expect, test } from 'claude-code/testing'

import { layout, toState } from '../hooks/layout'
import type { Ci } from '../types'

const text = (ci: Ci, isExpanded = false) =>
  layout(ci, isExpanded).map(row => row.map(seg => seg.text).join(''))

const green: Ci = {
  sha: 'd2582276f700',
  isHead: true,
  runs: [
    { id: 1, name: 'Gate', state: 'ok', jobs: [{ name: 'gate', state: 'ok' }] },
    { id: 2, name: 'Validate', state: 'ok', jobs: [{ name: 'lint / rubocop', state: 'ok' }] },
  ],
}

test('a green commit is one line of checkpoints', () => {
  expect(text(green)).toEqual(['CI d258227  ● Gate ── ● Validate'])
})

test('a failing workflow branches into its job groups under its checkpoint', () => {
  const ci: Ci = {
    ...green,
    isHead: false,
    runs: [
      green.runs[0]!,
      {
        id: 2,
        name: 'Validate',
        state: 'fail',
        jobs: [
          { name: 'lint / rubocop', state: 'ok' },
          { name: 'lint / brakeman', state: 'fail' },
          { name: 'test / minitest', state: 'run' },
        ],
      },
    ],
  }

  expect(text(ci)).toEqual([
    'CI d258227 ≠HEAD  ● Gate ── ✗ Validate',
    '                            ├─ lint ● ✗ brakeman',
    '                            └─ test ◐ minitest',
  ])
})

test('two open workflows hang right to left, the left one keeping its rail', () => {
  const ci: Ci = {
    ...green,
    runs: [
      { id: 1, name: 'A', state: 'fail', jobs: [{ name: 'build', state: 'fail' }] },
      { id: 2, name: 'B', state: 'run', jobs: [{ name: 'deploy', state: 'run' }] },
    ],
  }

  expect(text(ci)).toEqual([
    'CI d258227  ✗ A ── ◐ B',
    '            │      └─ ◐ deploy',
    '            └─ ✗ build',
  ])
})

test('expanded names every job of every workflow', () => {
  expect(text(green, true)).toEqual([
    'CI d258227  ● Gate ── ● Validate',
    '            │         └─ lint ● rubocop',
    '            └─ ● gate',
  ])
})

test('run states map from the GitHub status and conclusion', () => {
  expect(toState('in_progress', null)).toBe('run')
  expect(toState('queued', null)).toBe('wait')
  expect(toState('completed', 'success')).toBe('ok')
  expect(toState('completed', 'cancelled')).toBe('stop')
  expect(toState('completed', 'timed_out')).toBe('fail')
})
