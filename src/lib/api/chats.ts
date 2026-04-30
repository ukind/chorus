// Chat API endpoints
import { Chat } from "@/lib/types";
import { fetchFromDaemon } from "./client";

export async function listChats(options?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<Chat[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.append("limit", options.limit.toString());
  if (options?.offset) params.append("offset", options.offset.toString());
  if (options?.status) params.append("status", options.status);

  const query = params.toString();
  return fetchFromDaemon<Chat[]>(`/chats${query ? `?${query}` : ""}`);
}

export async function getChat(id: string): Promise<Chat> {
  return fetchFromDaemon<Chat>(`/chats/${id}`);
}

export async function createChat(options: {
  work: string;
  templateId: string;
  files?: string[];
}): Promise<Chat> {
  return fetchFromDaemon<Chat>("/chats", {
    method: "POST",
    body: JSON.stringify(options),
  });
}

export async function cancelChat(id: string): Promise<void> {
  await fetchFromDaemon<void>(`/chats/${id}/cancel`, { method: "POST" });
}

export async function resumeChat(id: string, answer: unknown): Promise<Chat> {
  return fetchFromDaemon<Chat>(`/chats/${id}/resume`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

export function streamChat(id: string): EventSource {
  const BASE_URL =
    process.env.NEXT_PUBLIC_CHORUS_DAEMON_URL || "http://127.0.0.1:7707";
  const url = new URL(`/chats/${id}/stream`, BASE_URL).toString();
  return new EventSource(url);
}

export async function listBlocked(): Promise<Chat[]> {
  return fetchFromDaemon<Chat[]>("/blocked");
}
