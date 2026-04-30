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
