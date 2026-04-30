/**
 * Chorus MCP tools — 7 tools wrapping daemon REST API.
 * Each tool has a Zod input schema and calls daemonFetch.
 */

import { z } from "zod";
import { daemonFetch, streamChat } from "./client";

// ─── Input schemas ───────────────────────────────────────────────────────

export const CreateChatSchema = z.object({
  work: z.string().min(1, "work prompt is required"),
  template: z.string().optional().default("code-review"),
  files: z.array(z.string()).optional(),
});

export const WaitForChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  timeoutSec: z.number().int().positive().optional().default(600),
});

export const GetChatStatusSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListBlockedSchema = z.object({});

export const ResumeChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
  answer: z.string().min(1, "answer is required"),
});

export const CancelChatSchema = z.object({
  chatId: z.string().min(1, "chatId is required"),
});

export const ListTemplatesSchema = z.object({});

// ─── Output schemas ─────────────────────────────────────────────────────

const ChatRefSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  url: z.string(),
});

const ChatStatusSchema = z.object({
  chatId: z.string(),
  status: z.string(),
  phase: z.number().optional(),
  progress: z.number().optional(),
  blocked: z.boolean().optional(),
});

const ChatResultSchema = z.object({
  status: z.string(),
  verdict: z.string().optional(),
  summary: z.string().optional(),
  blocked: z.boolean().optional(),
});

const BlockedChatSchema = z.object({
  chatId: z.string(),
  work: z.string(),
  blockedReason: z.string(),
  since: z.number(),
});

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  lineages: z.array(z.string()).optional(),
});

// ─── Tools ──────────────────────────────────────────────────────────────

/**
 * Create a new chat.
 * Returns immediately with chatId and status.
 */
export async function createChat(input: unknown) {
  const parsed = CreateChatSchema.parse(input);

  const result = await daemonFetch<unknown>("/chats", {
    method: "POST",
    body: JSON.stringify({
      work: parsed.work,
      templateId: parsed.template,
      files: parsed.files,
    }),
  });

  return ChatRefSchema.parse(result);
}

/**
 * Long-poll a chat until terminal state.
 * Emits progress events via SSE stream.
 * Resolves when status flips to terminal.
 */
export async function waitForChat(
  input: unknown,
  onProgress: (event: Record<string, unknown>) => void
) {
  const parsed = WaitForChatSchema.parse(input);

  for await (const event of streamChat(parsed.chatId, parsed.timeoutSec)) {
    onProgress(event);

    // Check if we've reached a terminal state
    if (event && typeof event === "object") {
      const status = (event as Record<string, unknown>).status;
      if (
        status === "approved" ||
        status === "merged" ||
        status === "blocked" ||
        status === "cancelled" ||
        status === "failed"
      ) {
        return ChatResultSchema.parse(event);
      }
    }
  }

  // If stream closed without reaching terminal, fetch final status
  const result = await daemonFetch<unknown>(`/chats/${parsed.chatId}`);
  return ChatResultSchema.parse(result);
}

/**
 * Get current chat status without blocking.
 */
export async function getChatStatus(input: unknown) {
  const parsed = GetChatStatusSchema.parse(input);

  const result = await daemonFetch<unknown>(`/chats/${parsed.chatId}`);
  return ChatStatusSchema.parse(result);
}

/**
 * List all blocked chats.
 */
export async function listBlocked(input: unknown) {
  ListBlockedSchema.parse(input);
  // input is empty object, but we validate it anyway for schema consistency

  const result = await daemonFetch<unknown>("/blocked");

  // Result should be an array of blocked chats
  const chats = z.array(BlockedChatSchema).parse(
    Array.isArray(result) ? result : (result as Record<string, unknown>).chats || []
  );

  return { chats };
}

/**
 * Resume a blocked chat with a user answer.
 */
export async function resumeChat(input: unknown) {
  const parsed = ResumeChatSchema.parse(input);

  const result = await daemonFetch<unknown>(
    `/chats/${parsed.chatId}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ answer: parsed.answer }),
    }
  );

  return { ok: true, status: ChatStatusSchema.parse(result) };
}

/**
 * Cancel a chat.
 */
export async function cancelChat(input: unknown) {
  const parsed = CancelChatSchema.parse(input);

  await daemonFetch<unknown>(`/chats/${parsed.chatId}/cancel`, {
    method: "POST",
  });

  return { ok: true };
}

/**
 * List all available templates.
 */
export async function listTemplates(input: unknown) {
  ListTemplatesSchema.parse(input);
  // input is empty object, but we validate it anyway for schema consistency

  const result = await daemonFetch<unknown>("/templates");

  // Result should be an array of templates
  const templates = z.array(TemplateSchema).parse(
    Array.isArray(result) ? result : (result as Record<string, unknown>).templates || []
  );

  return { templates };
}
