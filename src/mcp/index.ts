#!/usr/bin/env node

/**
 * Chorus MCP stdio server.
 * Exposes 7 tools to orchestrators (Claude Code, Codex, Cursor).
 * Each tool calls the daemon REST API on http://127.0.0.1:7707.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createChat,
  waitForChat,
  getChatStatus,
  listBlocked,
  resumeChat,
  cancelChat,
  listTemplates,
  CreateChatSchema,
  WaitForChatSchema,
  GetChatStatusSchema,
  ListBlockedSchema,
  ResumeChatSchema,
  CancelChatSchema,
  ListTemplatesSchema,
} from "./tools.js";

const mcpServer = new McpServer({
  name: "chorus",
  version: "0.5.0",
});

/**
 * Register the 7 MCP tools.
 */

mcpServer.registerTool(
  "create_chat",
  {
    description:
      "Create a new chat. Returns immediately with chatId, status, and URL. Reviewers run async.",
    inputSchema: CreateChatSchema,
  },
  async (input) => {
    const result = await createChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "wait_for_chat",
  {
    description:
      "Long-poll a chat until terminal state. Blocks until status is approved, merged, blocked, cancelled, or failed.",
    inputSchema: WaitForChatSchema,
  },
  async (input) => {
    const progressEvents: Record<string, unknown>[] = [];
    const result = await waitForChat(input, (event) => {
      progressEvents.push(event);
      // Emit MCP notification for each phase transition
      mcpServer.server.notification({
        method: "notifications/message",
        params: {
          level: "info",
          data: event,
        },
      });
    });

    const response = {
      ...(result as Record<string, unknown>),
      events: progressEvents,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(response) }],
    };
  }
);

mcpServer.registerTool(
  "get_chat_status",
  {
    description:
      "Get current chat status without blocking. Returns status, phase, progress, and blocked flag.",
    inputSchema: GetChatStatusSchema,
  },
  async (input) => {
    const result = await getChatStatus(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "list_blocked",
  {
    description:
      "List all chats currently waiting on user input. Lets you surface them in one prompt.",
    inputSchema: ListBlockedSchema,
  },
  async (input) => {
    const result = await listBlocked(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "resume_chat",
  {
    description:
      "Unblock a chat after the user has decided. Same effect as clicking the dashboard button.",
    inputSchema: ResumeChatSchema,
  },
  async (input) => {
    const result = await resumeChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "cancel_chat",
  {
    description:
      "Hard cancel — kills the tmux session, stops reviewers, marks chat cancelled.",
    inputSchema: CancelChatSchema,
  },
  async (input) => {
    const result = await cancelChat(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

mcpServer.registerTool(
  "list_templates",
  {
    description:
      "List all available templates (built-in and user-created). Use to discover templates for create_chat.",
    inputSchema: ListTemplatesSchema,
  },
  async (input) => {
    const result = await listTemplates(input);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

/**
 * Main entry point.
 * Creates stdio transport and connects server.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

main().catch((error: unknown) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
