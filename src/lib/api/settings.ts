// Settings and secrets API endpoints
import { Settings, Secret } from "@/lib/types";
import { fetchFromDaemon } from "./client";

export async function getSettings(): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings");
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return fetchFromDaemon<Settings>("/settings", {
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
