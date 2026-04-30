import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LiveRunReal } from "@/components/live-run-real";
import { getChat, getTemplate, DaemonError } from "@/lib/api";

export const dynamic = "force-dynamic";

interface RunPageProps {
  params: Promise<{ runId: string }>;
}

async function getRunData(runId: string) {
  try {
    const chat = await getChat(runId);
    const template = await getTemplate(chat.templateId);
    return { chat, template };
  } catch (err) {
    throw err instanceof DaemonError ? err : new Error("Failed to load run data");
  }
}

const AGENT_TO_LINEAGE: Record<string, "claude" | "codex" | "gemini" | "opencode" | "kimi"> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "opencode-cli": "opencode",
  "kimi-cli": "kimi",
};

interface ParticipantSnapshot {
  participant: string;
  role: "doer" | "reviewer";
  agentName: string;
  lineage: "claude" | "codex" | "gemini" | "opencode" | "kimi";
  hasAnswer: boolean;
  answer?: string;
  findingsPreview?: string[];
}

interface RoundSnapshot {
  round: number;
  participants: ParticipantSnapshot[];
}

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
        const role: "doer" | "reviewer" = d.name.startsWith("doer-") ? "doer" : "reviewer";
        const rawAgent = d.name.replace(/^(doer-|reviewer-)/, "").replace(/-\d+$/, "");
        const lineage = AGENT_TO_LINEAGE[rawAgent] ?? "claude";
        const answerPath = path.join(roundDir, d.name, "answer.md");
        let hasAnswer = false;
        let answer: string | undefined;
        let findingsPreview: string[] | undefined;
        if (fs.existsSync(answerPath)) {
          hasAnswer = true;
          try {
            answer = fs.readFileSync(answerPath, "utf-8");
            findingsPreview = answer
              .split("\n")
              .filter((l) => l.trim().length > 0 && !l.startsWith("##"))
              .slice(0, 4)
              .map((l) => (l.length > 90 ? l.slice(0, 90) + "…" : l));
          } catch {
            answer = undefined;
          }
        }
        return { participant: d.name, role, agentName: rawAgent, lineage, hasAnswer, answer, findingsPreview };
      });

    rounds.push({ round: roundNum, participants });
  }

  return rounds.sort((a, b) => a.round - b.round);
}

export default async function RunPage({ params }: RunPageProps) {
  const { runId } = await params;
  const { chat, template } = await getRunData(runId);

  if (!chat) {
    notFound();
  }

  const initialRounds = readChatRounds(chat.id);

  return (
    <AppShell>
      <LiveRunReal
        chatId={chat.id}
        initialStatus={chat.status}
        initialRounds={initialRounds}
        template={template}
        work={chat.work}
        initialPrUrl={chat.prUrl}
        initialShipError={chat.shipError}
      />
    </AppShell>
  );
}
