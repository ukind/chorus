/**
 * Filesystem-backed artifacts endpoint for the run page.
 * Returns the structure of ~/.chorus/chats/<id>/round-N/<participant>/answer.md
 * as a JSON tree the LiveRunReal client component can consume.
 *
 * Reads from disk, no DB. Cheap enough to poll every 4s. Daemon and Next.js
 * are co-hosted so the filesystem read is local.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: string;
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
}

interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

const AGENT_TO_LINEAGE: Record<string, string> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "opencode-cli": "opencode",
  "kimi-cli": "kimi",
};

function readChatRounds(chatId: string): RoundSnapshot[] {
  const chatDir = path.join(os.homedir(), ".chorus", "chats", chatId);
  if (!fs.existsSync(chatDir)) return [];

  const entries = fs
    .readdirSync(chatDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("round-"));

  const rounds: RoundSnapshot[] = [];
  for (const entry of entries) {
    const roundNum = parseInt(entry.name.replace("round-", ""), 10);
    if (!Number.isFinite(roundNum)) continue;

    const roundDir = path.join(chatDir, entry.name);
    const participants: ParticipantSnapshot[] = fs
      .readdirSync(roundDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const role: "doer" | "reviewer" = d.name.startsWith("doer-")
          ? "doer"
          : "reviewer";
        // Strip role prefix and trailing -N for reviewer indices.
        const rawAgent = d.name.replace(/^(doer-|reviewer-)/, "").replace(/-\d+$/, "");
        const lineage = AGENT_TO_LINEAGE[rawAgent] ?? rawAgent;
        const answerPath = path.join(roundDir, d.name, "answer.md");
        // `hasAnswer` MUST mean "non-empty" — the runner pre-creates an
        // empty answer.md when the spawn starts so live tail can poll the
        // file mid-stream. If we treat any existing file as completed, the
        // phase stepper flips to DONE the millisecond the doer starts. See
        // ROADMAP #15.
        let hasAnswer = false;
        let answer: string | undefined;
        let findingsPreview: string[] | undefined;
        if (fs.existsSync(answerPath)) {
          try {
            answer = fs.readFileSync(answerPath, "utf-8");
            hasAnswer = answer.trim().length > 0;
            findingsPreview = answer
              .split("\n")
              .filter((l) => l.trim().length > 0 && !l.startsWith("##"))
              .slice(0, 4)
              .map((l) => (l.length > 90 ? l.slice(0, 90) + "…" : l));
          } catch {
            answer = undefined;
          }
        }
        return {
          participant: d.name,
          role,
          agentName: rawAgent,
          lineage,
          hasAnswer,
          answer,
          findingsPreview,
        };
      });

    rounds.push({ round: roundNum, participants });
  }

  return rounds.sort((a, b) => a.round - b.round);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  // Defense-in-depth: chatId is a ULID-looking string. Reject paths with `..`
  // or slashes so a malformed param can't escape the chats dir.
  if (chatId.includes("..") || chatId.includes("/") || chatId.includes("\\")) {
    return Response.json({ rounds: [] }, { status: 400 });
  }
  const rounds = readChatRounds(chatId);
  return Response.json({ rounds });
}
