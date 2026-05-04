// Settings and secrets API endpoints
import { Settings, Secret } from "@/lib/types";
import { fetchFromDaemon } from "./client";

export type SandboxProfile = "strict" | "workspace" | "full";

export interface PermissionSettings {
  sandboxProfile: SandboxProfile;
  autoApprovePrompts: boolean;
  networkAccess: boolean;
  profileDescriptions?: Record<SandboxProfile, { label: string; description: string }>;
}

export async function getPermissions(): Promise<PermissionSettings> {
  return fetchFromDaemon<PermissionSettings>("/settings/permissions");
}

export type DetectableCliId =
  | "claude-code"
  | "codex-cli"
  | "gemini-cli"
  | "opencode-cli"
  | "kimi-cli";

export interface CliDetection {
  id: DetectableCliId;
  found: boolean;
  path?: string;
  source?: "path" | "fallback" | "manual";
}

export async function detectInstalledClis(): Promise<CliDetection[]> {
  return fetchFromDaemon<CliDetection[]>("/onboard/detect-clis");
}

export async function validateCliPath(
  id: DetectableCliId,
  path: string,
): Promise<CliDetection> {
  return fetchFromDaemon<CliDetection>("/onboard/validate-cli-path", {
    method: "POST",
    body: JSON.stringify({ id, path }),
  });
}

export async function updatePermissions(
  patch: Partial<Omit<PermissionSettings, "profileDescriptions">>,
): Promise<PermissionSettings> {
  return fetchFromDaemon<PermissionSettings>("/settings/permissions", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function getSettings(): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings");
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export type Transport = "headless" | "tmux";

export interface TransportSettings {
  transport: Transport;
  descriptions?: Record<Transport, { label: string; description: string }>;
  /** False on Windows OR when the tmux binary isn't on PATH — cockpit
   *  greys out the Tmux card and shows an install hint instead of letting
   *  the user opt into a mode whose first chat would hang. */
  tmuxAvailable?: boolean;
}

export async function getTransport(): Promise<TransportSettings> {
  return fetchFromDaemon<TransportSettings>("/settings/transport");
}

export async function updateTransport(
  patch: { transport: Transport },
): Promise<TransportSettings> {
  return fetchFromDaemon<TransportSettings>("/settings/transport", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export type BillingMode = "api" | "subscription" | "mixed";

export interface BillingSettings {
  mode: BillingMode;
  descriptions?: Record<BillingMode, { label: string; description: string }>;
}

export async function getBillingMode(): Promise<BillingSettings> {
  return fetchFromDaemon<BillingSettings>("/settings/billing");
}

export async function updateBillingMode(
  patch: { mode: BillingMode },
): Promise<BillingSettings> {
  return fetchFromDaemon<BillingSettings>("/settings/billing", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface TelemetryStatus {
  enabled: boolean;
  envOverride: boolean;
  fileOverride: boolean;
  settingValue: boolean | undefined;
  endpoint: string;
}

export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  return fetchFromDaemon<TelemetryStatus>("/settings/telemetry");
}

export async function updateTelemetryEnabled(
  enabled: boolean,
): Promise<TelemetryStatus> {
  return fetchFromDaemon<TelemetryStatus>("/settings/telemetry", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function listSecrets(): Promise<Secret[]> {
  return fetchFromDaemon<Secret[]>("/secrets");
}

export async function upsertSecret(
  provider: string,
  secret: Omit<Secret, "provider">,
): Promise<Secret> {
  return fetchFromDaemon<Secret>(`/secrets/${provider}`, {
    method: "PUT",
    body: JSON.stringify(secret),
  });
}
