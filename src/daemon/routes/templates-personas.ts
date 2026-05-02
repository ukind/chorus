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

  // Save / update template. Preserves source='builtin' on existing builtin
  // rows so the daemon can still refresh them from disk on next boot. New
  // rows are always source='user'.
  fastify.post<{
    Body: { id: string; yaml: string };
    Reply: ApiResponse<object>;
  }>('/templates', async (request) => {
    try {
      const { id, yaml: yamlContent } = request.body;
      if (!id || !yamlContent) {
        return errorResponse('validation', 'id and yaml are required');
      }
      try {
        yaml.parse(yamlContent);
      } catch (parseError) {
        return errorResponse('validation', `Invalid YAML: ${parseError}`);
      }
      const existing = await templates.getById(id);
      const source: 'builtin' | 'user' =
        existing?.source === 'builtin' ? 'builtin' : 'user';
      const template = await templates.create(id, yamlContent, source);
      return successResponse(template);
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
