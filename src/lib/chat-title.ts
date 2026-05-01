/**
 * Extract a display-worthy title from a chat's `work` field.
 *
 * Why this exists: `mcp__chorus__invoke_persona` composes the chat's `work`
 * as `# Persona: <Label>\n\n<system_prompt>\n\n---\n\n# User request\n\n<brief>`.
 * Without unwrapping, every Cartographer / Sentinel / Profiler chat looks
 * identical in the sidebar — the first 200 chars are always the persona's
 * worldview prompt, never the user's actual request. See ROADMAP #13.
 *
 * The helper matches the exact structure invoke_persona writes today, returns
 * `[Persona] <user request>` when it can extract both, and falls back to the
 * raw work string otherwise so non-persona chats stay unaffected.
 */

const PERSONA_PREFIX_RE = /^# Persona: (.+?)\n[\s\S]+?\n---\n\n# User request\n\n([\s\S]+)$/;

export function chatDisplayTitle(work: string): string {
  if (!work) return "";
  const m = PERSONA_PREFIX_RE.exec(work);
  if (m) {
    const persona = m[1].trim();
    const request = m[2].trim();
    return `[${persona}] ${request}`;
  }
  return work;
}
