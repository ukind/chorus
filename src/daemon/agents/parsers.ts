/**
 * Per-CLI stream-json parsers. Pure functions: take a single line of stdout,
 * return zero-or-more AgentEvents. No I/O, no state — unit-testable in
 * isolation from the spawn/transport layer.
 *
 * Each parser is paired with a shim's `runHeadless` (Phase B). To add a new
 * CLI: capture sample output, write the parser here, add an inline test
 * fixture below, then have the shim call `spawnHeadless({ parseLine: parseX })`.
 */

import type { AgentEvent } from './types.js';

/**
 * Helper: try JSON.parse, return undefined on malformed lines (CLIs sometimes
 * emit blank lines, log lines, or partial frames in error paths).
 */
function tryJson(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// ─── Claude Code (claude --print --output-format stream-json --verbose) ────
//
// Real format captured 2026-04-30 from Claude Code 2.1.123:
//
//   {type:"system", subtype:"init"|"status"|"hook_started"|...}
//   {type:"stream_event", event:{type:"message_start", message:{...}}}
//   {type:"stream_event", event:{type:"content_block_delta",
//                                delta:{type:"text_delta", text:"..."}}}
//   {type:"stream_event", event:{type:"content_block_start",
//                                content_block:{type:"tool_use", name, input}}}
//   {type:"stream_event", event:{type:"message_stop"}}
//   {type:"assistant", message:{content:[{type:"text", text:"..."}]}}
//   {type:"rate_limit_event", rate_limit_info:{...}}
//   {type:"result", subtype:"success"|"error", result:"...", is_error,
//                   total_cost_usd, duration_ms, ...}
export function parseClaude(line: string): AgentEvent[] {
  const obj = tryJson(line) as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object') return [];

  const t = obj.type;

  // Final result line — emit message_done with the assembled text.
  if (t === 'result') {
    const subtype = obj.subtype as string | undefined;
    const isError = obj.is_error as boolean | undefined;
    if (subtype === 'success' && !isError) {
      return [{ type: 'message_done', finalText: String(obj.result ?? '') }];
    }
    return [
      {
        type: 'error',
        kind: 'claude_result_error',
        message: String(obj.result ?? obj.api_error_status ?? 'Claude reported error'),
      },
    ];
  }

  // Streaming deltas — text and tool calls.
  if (t === 'stream_event') {
    const event = (obj.event as Record<string, unknown> | undefined) ?? {};
    const eventType = event.type;

    if (eventType === 'content_block_delta') {
      const delta = (event.delta as Record<string, unknown> | undefined) ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        return [{ type: 'text_delta', text: delta.text }];
      }
      // Tool input deltas arrive as input_json_delta — not surfaced for now;
      // the tool_call_start (below) carries the initial input snapshot which
      // is enough for UI ("called Read on /path/x.ts").
      return [];
    }

    if (eventType === 'content_block_start') {
      const block = (event.content_block as Record<string, unknown> | undefined) ?? {};
      if (block.type === 'tool_use') {
        return [
          {
            type: 'tool_call_start',
            tool: typeof block.name === 'string' ? block.name : 'unknown',
            input: block.input,
          },
        ];
      }
      return [];
    }

    if (eventType === 'content_block_stop') {
      // We don't emit tool_call_end from Claude's stream — Claude emits
      // a tool_result message later that we'd need to track separately.
      // Skipping for now; UI shows tool_call_start in the trace, which is
      // enough for live progress.
      return [];
    }

    return [];
  }

  // System (init, hook events, status), assistant (assembled message),
  // rate_limit_event — silently ignored for now. Future: surface
  // rate_limit_event into the cli-health module so cockpit can show
  // "Claude resets at <time>" without waiting for a quota_exhausted error.
  return [];
}

// ─── Gemini CLI (gemini -p --output-format stream-json) ────────────────────
//
// Real format captured 2026-04-30 from gemini-cli with model
// gemini-3.1-pro-preview:
//
//   {"type":"init", "session_id", "model"}
//   {"type":"message", "role":"user", "content":"..."}
//   {"type":"message", "role":"assistant", "content":"<chunk>", "delta":true}
//   {"type":"result", "status":"success", "stats":{...}}
//
// The `result` line carries only stats — final text is the concatenation of
// all `delta:true` chunks. Runner accumulates from text_delta events and
// uses that on `message_done` (which we emit with finalText="" so the
// runner's fallback to `accumulated` kicks in).
export function parseGemini(line: string): AgentEvent[] {
  const obj = tryJson(line) as Record<string, unknown> | undefined;
  if (!obj) return [];

  const t = obj.type;

  // Streaming assistant chunks: delta=true with role=assistant.
  if (t === 'message' && obj.role === 'assistant' && obj.delta === true) {
    if (typeof obj.content === 'string' && obj.content.length > 0) {
      return [{ type: 'text_delta', text: obj.content }];
    }
    return [];
  }

  // Tool calls (functionCall) — Gemini CLI uses `functionCall` in delta
  // messages. Best-effort detection on common shape variants.
  if (t === 'message' && obj.functionCall) {
    const fc = obj.functionCall as Record<string, unknown>;
    return [
      {
        type: 'tool_call_start',
        tool: typeof fc.name === 'string' ? fc.name : 'unknown',
        input: fc.args,
      },
    ];
  }

  // Result line — emit message_done with empty text; runner falls back to
  // the accumulated deltas. On error, emit error event with the message.
  if (t === 'result') {
    const status = obj.status as string | undefined;
    if (status === 'success') {
      return [{ type: 'message_done', finalText: '' }];
    }
    return [
      {
        type: 'error',
        kind: 'gemini_result_error',
        message:
          typeof obj.error === 'string'
            ? obj.error
            : typeof obj.message === 'string'
              ? obj.message
              : `Gemini result status=${status ?? 'unknown'}`,
      },
    ];
  }

  // init, user-echo message, anything else — silently ignore.
  return [];
}

// ─── Kimi CLI (kimi --print --output-format stream-json) ───────────────────
//
// Kimi is intentionally Claude-Code-compatible. Its stream-json is documented
// to follow the Claude shape, so parseClaude is a reasonable starting point.
// Phase B verification step: capture real output and confirm.
export function parseKimi(line: string): AgentEvent[] {
  return parseClaude(line);
}

// ─── OpenCode (opencode run --format json) ─────────────────────────────────
//
// OpenCode `run --format json` (v1.14+) emits JSON Lines — one event per
// line: step_start, text, tool calls, step-finish. The text events carry
// the LLM output under `part.text` and are what the runner cares about.
// parseOpencode emits text_delta for each text event; parseOpencodeExit
// is a fallback for older builds that emit a single JSON blob.
export function parseOpencode(line: string): AgentEvent[] {
  const obj = tryJson(line) as Record<string, unknown> | undefined;
  if (!obj || obj.type !== 'text') return [];
  const part = obj.part as Record<string, unknown> | undefined;
  const text = part && typeof part.text === 'string' ? part.text : '';
  if (text.length === 0) return [];
  return [{ type: 'text_delta', text }];
}

/**
 * OpenCode on-exit handler — fallback for non-JSON-Lines stdout. With
 * `--format json` on opencode 1.14+, parseOpencode already pulled out the
 * text events, so this is a no-op in that case. Older builds (or a
 * single-blob fallback shape) still resolve here.
 */
export function parseOpencodeExit(fullStdout: string): AgentEvent[] {
  if (fullStdout.trim().length === 0) return [];
  // If the stdout starts with a JSON-Lines stream, parseOpencode already
  // handled it — don't double-emit.
  const firstLine = fullStdout.split('\n').find((l) => l.trim().length > 0);
  if (firstLine) {
    const probe = tryJson(firstLine) as Record<string, unknown> | undefined;
    if (probe && typeof probe.type === 'string') return [];
  }
  const obj = tryJson(fullStdout) as Record<string, unknown> | undefined;
  if (!obj) return [{ type: 'message_done', finalText: fullStdout }];
  const text =
    (typeof obj.message === 'string' && obj.message) ||
    (typeof obj.result === 'string' && obj.result) ||
    (typeof obj.output === 'string' && obj.output) ||
    fullStdout;
  return [{ type: 'message_done', finalText: text }];
}

// ─── Codex (codex exec) ────────────────────────────────────────────────────
//
// Codex `exec` writes plain stdout — no stream-json. We emit nothing during
// the run (heartbeat keeps UI alive), then on exit emit one `message_done`
// with the full stdout. Some Codex versions interleave thinking/tool-use
// markers in stdout; we don't try to parse those for v0.5.
export function parseCodex(_line: string): AgentEvent[] {
  return [];
}

export function parseCodexExit(fullStdout: string): AgentEvent[] {
  if (fullStdout.trim().length === 0) return [];
  return [{ type: 'message_done', finalText: fullStdout }];
}

// ============================================================================
// Inline Tests (run with: pnpm exec tsx src/daemon/agents/parsers.ts)
// ============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function runTests(): void {
  // ─── Claude parser ─────────────────────────────────────────────────────
  // Captured 2026-04-30 from real `claude --print --output-format stream-json`.
  const claudeFixture = [
    '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_01"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" friend"}},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"content_block_stop","index":0},"session_id":"abc"}',
    '{"type":"stream_event","event":{"type":"message_stop"},"session_id":"abc"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Hi there friend","total_cost_usd":0.26}',
  ];

  const events: AgentEvent[] = [];
  for (const line of claudeFixture) events.push(...parseClaude(line));

  // Should produce: 2 text_deltas + 1 message_done
  const textDeltas = events.filter((e) => e.type === 'text_delta');
  assertEq(textDeltas.length, 2, 'Test 1: 2 text_delta events');
  assertEq(
    (textDeltas[0] as { type: 'text_delta'; text: string }).text,
    'Hi there',
    'Test 1: first delta text',
  );
  assertEq(
    (textDeltas[1] as { type: 'text_delta'; text: string }).text,
    ' friend',
    'Test 1: second delta text',
  );

  const dones = events.filter((e) => e.type === 'message_done');
  assertEq(dones.length, 1, 'Test 1: exactly 1 message_done');
  assertEq(
    (dones[0] as { type: 'message_done'; finalText: string }).finalText,
    'Hi there friend',
    'Test 1: message_done finalText',
  );
  console.log('✓ Test 1 (parseClaude — text deltas + result): PASS');

  // ─── Claude tool_use ───────────────────────────────────────────────────
  const toolLine =
    '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/x.ts"}}},"session_id":"abc"}';
  const toolEvents = parseClaude(toolLine);
  assertEq(toolEvents.length, 1, 'Test 2: 1 tool_call_start event');
  assertEq(toolEvents[0].type, 'tool_call_start', 'Test 2: kind is tool_call_start');
  assertEq(
    (toolEvents[0] as { type: 'tool_call_start'; tool: string }).tool,
    'Read',
    'Test 2: tool name extracted',
  );
  console.log('✓ Test 2 (parseClaude — tool_use): PASS');

  // ─── Claude error result ───────────────────────────────────────────────
  const errLine = '{"type":"result","subtype":"error","is_error":true,"result":"rate limited"}';
  const errEvents = parseClaude(errLine);
  assertEq(errEvents.length, 1, 'Test 3: 1 error event');
  assertEq(errEvents[0].type, 'error', 'Test 3: kind is error');
  console.log('✓ Test 3 (parseClaude — error result): PASS');

  // ─── Malformed lines ───────────────────────────────────────────────────
  assertEq(parseClaude('not json').length, 0, 'Test 4: malformed line → []');
  assertEq(parseClaude('').length, 0, 'Test 4: empty line → []');
  assertEq(parseClaude('{"type":"system","subtype":"hook_started"}').length, 0, 'Test 4: system line → []');
  console.log('✓ Test 4 (parseClaude — malformed/system lines): PASS');

  // ─── OpenCode on-exit ──────────────────────────────────────────────────
  const opencodeJson = '{"message":"Reviewed: looks good","cost":0.0}';
  const opencodeEvents = parseOpencodeExit(opencodeJson);
  assertEq(opencodeEvents.length, 1, 'Test 5: opencode exit → 1 event');
  assertEq(opencodeEvents[0].type, 'message_done', 'Test 5: kind is message_done');
  assertEq(
    (opencodeEvents[0] as { type: 'message_done'; finalText: string }).finalText,
    'Reviewed: looks good',
    'Test 5: finalText extracted from message field',
  );
  console.log('✓ Test 5 (parseOpencodeExit — JSON blob): PASS');

  // ─── OpenCode malformed exit (raw text fallback) ───────────────────────
  const rawText = 'Reviewed in plain text\n';
  const rawEvents = parseOpencodeExit(rawText);
  assertEq(rawEvents.length, 1, 'Test 6: raw text → 1 event');
  assertEq(
    (rawEvents[0] as { type: 'message_done'; finalText: string }).finalText,
    rawText,
    'Test 6: raw text preserved as finalText',
  );
  console.log('✓ Test 6 (parseOpencodeExit — raw text fallback): PASS');

  // ─── Codex on-exit ─────────────────────────────────────────────────────
  const codexEvents = parseCodexExit('Code reviewed.\nVerdict: approve.');
  assertEq(codexEvents.length, 1, 'Test 7: codex exit → 1 event');
  assertEq(codexEvents[0].type, 'message_done', 'Test 7: kind is message_done');
  console.log('✓ Test 7 (parseCodexExit): PASS');

  // ─── Gemini parser — real fixture captured 2026-04-30 ──────────────────
  const geminiFixture = [
    '{"type":"init","timestamp":"2026-04-30T12:16:50.412Z","session_id":"sess-1","model":"gemini-3.1-pro-preview"}',
    '{"type":"message","timestamp":"2026-04-30T12:16:50.416Z","role":"user","content":"say hi in 3 words"}',
    '{"type":"message","timestamp":"2026-04-30T12:16:54.358Z","role":"assistant","content":"Hi there friend!","delta":true}',
    '{"type":"result","timestamp":"2026-04-30T12:16:54.419Z","status":"success","stats":{"total_tokens":11638}}',
  ];
  const gemEvents: AgentEvent[] = [];
  for (const line of geminiFixture) gemEvents.push(...parseGemini(line));

  const gemDeltas = gemEvents.filter((e) => e.type === 'text_delta');
  assertEq(gemDeltas.length, 1, 'Test 8a: gemini → 1 text_delta');
  assertEq(
    (gemDeltas[0] as { type: 'text_delta'; text: string }).text,
    'Hi there friend!',
    'Test 8a: gemini delta text',
  );

  const gemDones = gemEvents.filter((e) => e.type === 'message_done');
  assertEq(gemDones.length, 1, 'Test 8b: gemini → 1 message_done');
  assertEq(
    (gemDones[0] as { type: 'message_done'; finalText: string }).finalText,
    '',
    'Test 8b: gemini message_done has empty finalText (runner falls back to accumulated)',
  );

  // Gemini error result
  const gemErr = parseGemini('{"type":"result","status":"error","error":"rate limit"}');
  assertEq(gemErr.length, 1, 'Test 8c: gemini error result → 1 event');
  assertEq(gemErr[0].type, 'error', 'Test 8c: kind is error');
  console.log('✓ Test 8 (parseGemini — real fixture): PASS');

  console.log('\n✅ All parser tests passed!');
}

declare const require: { main?: NodeModule } | undefined;
declare const module: NodeModule | undefined;
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runTests();
}
