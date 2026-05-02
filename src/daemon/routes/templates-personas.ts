/**
 * /templates and /personas routes.
 *
 * These are pure DB CRUD — no coupling to the runner, the singleton
 * activeRuns map, or the SSE multiplex. Extracted out of index.ts as
 * part of the post-audit refactor that brought the daemon entry file
 * under 700 lines.
 */
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { templates } from '../../lib/db/index.js';
import { validateTemplateYaml } from '../../lib/template-validation.js';
import {
  successResponse,
  errorResponse,
  type ApiResponse,
} from '../api-response.js';

export function registerTemplateRoutes(fastify: FastifyInstance): void {
  // List all templates
  fastify.get<{ Reply: ApiResponse<object[]> }>('/templates', async () => {
    try {
      const list = await templates.list();
      return successResponse(list);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Get one template
  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/templates/:id', async (request) => {
    try {
      const template = await templates.getById(request.params.id);
      if (!template) {
        return errorResponse('not_found', `Template ${request.params.id} not found`);
      }
      const parsed = yaml.parse(template.yaml);
      return successResponse({ ...template, parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  // Save / update template.
  //
  // Source promotion semantics:
  //   - New rows (no existing) → source='user'.
  //   - Edits to a builtin → source='user' AND we promote *only* if the YAML
  //     actually changed. Why: seedBuiltinTemplates() resyncs every builtin
  //     row from prompts/templates/*.yaml on each daemon boot. If we left an
  //     edited row marked 'builtin', the seed loop would clobber the user's
  //     changes on next restart. Promoting to 'user' makes the seed loop
  //     skip the row (it only refreshes source='builtin'), so edits persist.
  //     The user accepts the tradeoff: their fork no longer auto-receives
  //     future builtin updates from chorus upgrades. That's the *expected*
  //     behaviour of "I edited this, it's mine now."
  //   - Edits to an existing user row → stay 'user' (no-op).
  //   - Save with identical YAML on a builtin → stay 'builtin' (we don't
  //     accidentally fork from a no-op resave).
  //
  // Validation runs in two stages so the cockpit can surface the *right*
  // error to the user:
  //   1. yaml.parse — catches syntax errors (indent, missing colon, etc.).
  //   2. TemplateSchema (zod) — catches structural errors (missing phases,
  //      unknown lineage, reviewer.require out of bounds, hybrid review_only,
  //      …). Without this stage a malformed-but-parseable template would
  //      land in the DB and crash the runner the first time it loads it
  //      (getParsedTemplate calls TemplateSchema.parse with no fallback).
  //
  // Zod errors are flattened to {path, message} pairs so the editor can
  // pin each error to its field; the response shape matches the existing
  // ApiResponse `{ error, details: { issues } }` envelope.
  fastify.post<{
    Body: { id: string; yaml: string };
    Reply: ApiResponse<object>;
  }>('/templates', async (request) => {
    try {
      const { id, yaml: yamlContent } = request.body;
      if (!id || !yamlContent) {
        return errorResponse('validation', 'id and yaml are required');
      }

      const validation = validateTemplateYaml(yamlContent);
      if (!validation.valid) {
        const summary = validation.issues
          .slice(0, 3)
          .map((i) => `${i.path}: ${i.message}`)
          .join('; ');
        return errorResponse(
          'validation',
          `Template failed validation: ${summary}${validation.issues.length > 3 ? ` (+${validation.issues.length - 3} more)` : ''}`,
          { issues: validation.issues },
        );
      }

      const existing = await templates.getById(id);
      let source: 'builtin' | 'user';
      if (!existing) {
        source = 'user';
      } else if (existing.source === 'builtin' && existing.yaml === yamlContent) {
        // No-op resave on a builtin — keep it as 'builtin' so the disk
        // resync still works on next boot.
        source = 'builtin';
      } else {
        // Real edit OR an existing user row — both end up as 'user'.
        source = 'user';
      }
      const template = await templates.create(id, yamlContent, source);
      return successResponse({ ...template, sourcePromoted: existing?.source === 'builtin' && source === 'user' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });
}

export function registerPersonaRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Reply: ApiResponse<object[]> }>('/personas', async () => {
    try {
      const { listPersonas } = await import('../../lib/personas.js');
      return successResponse(await listPersonas());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });

  fastify.get<{
    Params: { id: string };
    Reply: ApiResponse<object>;
  }>('/personas/:id', async (request) => {
    try {
      const { getPersona } = await import('../../lib/personas.js');
      const row = await getPersona(request.params.id);
      if (!row) {
        return errorResponse('not_found', `Persona ${request.params.id} not found`);
      }
      return successResponse(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return errorResponse('db_error', message);
    }
  });
}
