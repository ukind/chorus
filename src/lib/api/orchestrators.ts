// Orchestrator integrations API — used by the /connect page to surface
// "is Claude Code wired up?" status and the one-click "Connect" button.
import { fetchFromDaemon } from "./client";

export type OrchestratorName =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "kimi"
  | "cursor"
  | "windsurf";

export interface OrchestratorStatus {
  name: OrchestratorName;
  label: string;
  connected: boolean;
  approvedTools: number;
  totalTools: number;
  note: string;
  supported: boolean;
  firstCallBehavior: "auto" | "prompts_once" | "inherits_global";
}

export interface ConnectResult {
  added: string[];
  alreadyPresent: string[];
  configPath: string;
  status: OrchestratorStatus;
}

export async function listOrchestrators(): Promise<OrchestratorStatus[]> {
  return fetchFromDaemon<OrchestratorStatus[]>("/orchestrators");
}

export async function connectOrchestrator(
  name: OrchestratorName,
): Promise<ConnectResult> {
  return fetchFromDaemon<ConnectResult>(`/orchestrators/${name}/connect`, {
    method: "POST",
  });
}
