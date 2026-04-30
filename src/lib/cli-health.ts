/**
 * Per-CLI health state, persisted in the settings table.
 *
 * Records the most recent failure mode the error-detector observed per
 * lineage, plus a timestamp and (when available) a reset-at time so the UI
 * can show "Codex resets at 10:05 PM".
 *
 * Recorded by: daemon's runner when it forwards cli_error events.
 * Read by: home-page CLI status panel via GET /cli/health.
 */

import { settings } from './db';

export type CliLineage =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'opencode'
  | 'moonshot';

export type HealthStatus =
  | 'healthy'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'rate_limited'
  | 'unknown';

export interface CliHealth {
  lineage: CliLineage;
  status: HealthStatus;
  /** Free-form one-liner for the UI. */
  message?: string;
  /** When the CLI is expected to recover (ms-epoch). undefined = unknown. */
  resetAt?: number;
  /** When this status was last updated (ms-epoch). */
  updatedAt: number;
}

const KEY = (l: CliLineage) => `cli_health.${l}`;

const ALL_LINEAGES: CliLineage[] = [
  'anthropic',
  'openai',
  'google',
  'opencode',
  'moonshot',
];

export function recordHealth(input: {
  lineage: CliLineage;
  status: HealthStatus;
  message?: string;
  resetAt?: number;
}): void {
  const payload: CliHealth = {
    lineage: input.lineage,
    status: input.status,
    message: input.message,
    resetAt: input.resetAt,
    updatedAt: Date.now(),
  };
  settings.set(KEY(input.lineage), payload);
}

export function getHealth(lineage: CliLineage): CliHealth {
  const raw = settings.get(KEY(lineage));
  if (raw && typeof raw === 'object' && 'status' in raw) {
    return raw as CliHealth;
  }
  return {
    lineage,
    status: 'unknown',
    updatedAt: 0,
  };
}

export function getAllHealth(): CliHealth[] {
  return ALL_LINEAGES.map(getHealth);
}

/**
 * Translate an error-detector CliErrorKind into a HealthStatus.
 * Used by the runner when forwarding cli_error events.
 */
export function kindToStatus(kind: string): HealthStatus {
  switch (kind) {
    case 'quota_exhausted':
      return 'quota_exhausted';
    case 'token_refresh_lost':
    case 'mcp_handshake_failed':
      return 'auth_invalid';
    default:
      return 'unknown';
  }
}
