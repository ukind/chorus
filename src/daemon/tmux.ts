import { execSync } from 'child_process';
import { chats } from '../lib/db';

const REAPER_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

let reaperInterval: NodeJS.Timeout | null = null;

export function initTmuxReaper(): void {
  if (reaperInterval) return;

  reaperInterval = setInterval(reapStaleSessions, REAPER_INTERVAL);
}

export function stopTmuxReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}

export function createSession(chatId: string): string {
  const sessionName = `chorus-${chatId}`;

  // Check if session exists
  try {
    execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'ignore' });
    return sessionName;
  } catch {
    // Session doesn't exist, create it
  }

  // Create new session (detached)
  execSync(`tmux new-session -d -s "${sessionName}"`);

  return sessionName;
}

export function killSession(chatId: string): void {
  const sessionName = `chorus-${chatId}`;

  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: 'ignore' });
  } catch {
    // Session may not exist, that's ok
  }
}

export function sendCommand(chatId: string, command: string): void {
  const sessionName = `chorus-${chatId}`;

  try {
    // Send command and press Enter
    execSync(`tmux send-keys -t "${sessionName}" "${command}" Enter`, { stdio: 'ignore' });
  } catch (error) {
    console.error(`Failed to send command to tmux session ${sessionName}:`, error);
  }
}

export function getSessionStatus(chatId: string): 'active' | 'inactive' | 'not_found' {
  const sessionName = `chorus-${chatId}`;

  try {
    const output = execSync(`tmux capture-pane -t "${sessionName}" -p`, { encoding: 'utf-8' });

    // Check if any output (basic check)
    return output.trim().length > 0 ? 'active' : 'inactive';
  } catch {
    return 'not_found';
  }
}

function reapStaleSessions(): void {
  try {
    // Get all tmux sessions
    const output = execSync('tmux list-sessions -F "#{session_name}"', { encoding: 'utf-8' });
    const sessions = output.trim().split('\n').filter((s) => s.startsWith('chorus-'));

    const now = Date.now();

    for (const sessionName of sessions) {
      const chatId = sessionName.replace('chorus-', '');

      // Check if chat exists and is still active
      const chat = chats.getById(chatId);

      if (!chat) {
        // Chat doesn't exist, kill session
        killSession(chatId);
        continue;
      }

      if (['cancelled', 'failed', 'merged'].includes(chat.status)) {
        // Chat is finished, kill session
        killSession(chatId);
        continue;
      }

      // Check if session has been idle for too long
      try {
        execSync(`tmux capture-pane -t "${sessionName}" -p -e -S -100`, {
          encoding: 'utf-8',
          timeout: 1000,
        });

        // Get session creation time (rough estimate via activity)
        // For now, we'll trust the chat's updated_at
        const timeSinceUpdate = now - chat.updated_at;

        if (timeSinceUpdate > SESSION_IDLE_TIMEOUT && chat.status === 'drafting') {
          // Session idle too long and still drafting
          killSession(chatId);
        }
      } catch {
        // Error accessing session, might be dead
        killSession(chatId);
      }
    }
  } catch (error) {
    console.error('Error in tmux reaper:', error);
  }
}

export async function runPhaseStub(chatId: string, phaseKind: string): Promise<string> {
  // v0.5 stub: fake a 2-3s delay then return mock output
  const delay = 2000 + Math.random() * 1000;

  await new Promise((resolve) => setTimeout(resolve, delay));

  const outputs: Record<string, string> = {
    plan: JSON.stringify({
      phases: [
        { idx: 0, kind: 'plan', title: 'Planning Phase' },
        { idx: 1, kind: 'spec', title: 'Specification' },
      ],
    }),
    spec: 'Specification document generated',
    tests: 'Unit tests written: 5 tests',
    implement: 'Implementation complete: 150 lines of code',
    review: JSON.stringify({ approved: true, comments: ['Good structure'] }),
    verify: 'All checks passed',
    divergence: JSON.stringify({ requiresUserInput: true, question: 'Proceed with merge?' }),
  };

  return outputs[phaseKind] || 'Phase completed';
}
