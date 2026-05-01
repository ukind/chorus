/**
 * Shared event shape emitted by the runner sub-modules and consumed by
 * the SSE multiplex in daemon/index.ts. Kept here (not in agents/types)
 * so doer/reviewer/runner can import without the circular runner.ts
 * dependency we'd hit if RunnerEvent stayed in the entry file.
 */
export interface RunnerEvent {
  chatId: string;
  type:
    | 'phase_start'
    | 'phase_progress'
    | 'phase_done'
    | 'phase_failed'
    | 'cli_error'
    | 'cli_warning'
    | 'chat_done';
  payload: Record<string, unknown>;
  ts: number;
}
