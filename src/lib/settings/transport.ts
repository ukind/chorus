/**
 * Typed accessor for chorus's transport setting — how shims invoke the
 * underlying CLI. Two modes:
 *
 *   - 'headless' (default): spawn the CLI in `--print` / `exec` / `run` mode,
 *     pipe prompt to stdin or argv, parse stream-json from stdout. No tmux,
 *     no TUI process resident, ~80% lower RAM, no permission prompts (the
 *     CLIs auto-approve in headless mode).
 *
 *   - 'tmux' (opt-in): spawn the CLI in its interactive TUI inside a tmux
 *     session, send the prompt via send-keys, watch answer.md for completion.
 *     Higher RAM, fragile pane-scraping, but humans can attach to the tmux
 *     session for visual debugging — useful if you want to watch the AI
 *     work step-by-step.
 *
 * Settings UI: cockpit /settings exposes this as "Show live terminal sessions"
 * (off=headless, on=tmux). No deprecation timeline — both modes are first-
 * class.
 *
 * The runner reads this once per chat (not per phase) so flipping the
 * setting mid-run is intentionally inert.
 */

import { settings } from '../db';
import { z } from 'zod';

export type Transport = 'headless' | 'tmux';

const TransportSchema = z.enum(['headless', 'tmux']);

const TRANSPORT_KEY = 'transport';

/**
 * v0.5 default is 'headless' — the migration target. Existing users who had
 * tmux working will see the same outputs in the cockpit; only the spawn
 * mechanism differs. To revert, flip the toggle in /settings or set the env
 * override `CHORUS_TRANSPORT=tmux` (env wins over settings — useful for CI
 * and per-user overrides without DB writes).
 */
export const DEFAULT_TRANSPORT: Transport = 'headless';

export function getTransport(): Transport {
  // Env override takes precedence — operator escape hatch.
  const envOverride = process.env.CHORUS_TRANSPORT;
  if (envOverride === 'headless' || envOverride === 'tmux') {
    return envOverride;
  }

  const raw = settings.get(TRANSPORT_KEY);
  const parsed = TransportSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_TRANSPORT;
}

export function setTransport(value: Transport): Transport {
  TransportSchema.parse(value);
  settings.set(TRANSPORT_KEY, value);
  return getTransport();
}

/**
 * Human-readable description for the /settings UI toggle.
 */
export const TRANSPORT_DESCRIPTIONS: Record<Transport, { label: string; description: string }> = {
  headless: {
    label: 'Headless (faster, default)',
    description:
      'Each CLI runs as a one-shot subprocess. ~80% less RAM, faster cold start, no permission dialogs. Recommended for everyday use.',
  },
  tmux: {
    label: 'Show live terminal sessions',
    description:
      'Each CLI runs in a persistent tmux session you can attach to (`tmux attach -t <name>`) for visual debugging. Uses more RAM but lets you see exactly what each agent is doing step-by-step.',
  },
};
