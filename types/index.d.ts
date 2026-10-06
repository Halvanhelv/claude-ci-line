export type State = 'ok' | 'fail' | 'run' | 'wait' | 'skip' | 'stop'

export type Job = { name: string; state: State }

export type Run = { id: number; name: string; state: State; jobs: Job[] }

export type Ci = { sha: string; isHead: boolean; runs: Run[] }

declare module 'claude-code' {
  interface PluginState {
    'ci-line': { ci: Ci | null; isExpanded: boolean }
  }
}
