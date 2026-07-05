// Server-rendered admin UI (PRD §A.5, DECISIONS D1): Eta templates, no
// frontend framework, no build step. The UI exists to give the P3 journeys a
// small, meaningful surface — semantic HTML with data-testid everywhere.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { FastifyReply } from 'fastify';
import type { Actor } from '../config.js';

const views = path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

export const eta = new Eta({ views, cache: process.env.NODE_ENV === 'production' });

export interface PageContext {
  actor?: Actor | undefined;
  flash?: string | undefined;
  flashKind?: 'ok' | 'err' | undefined;
  [key: string]: unknown;
}

export function renderPage(reply: FastifyReply, template: string, data: PageContext, status = 200): FastifyReply {
  return reply.code(status).type('text/html; charset=utf-8').send(eta.render(template, data));
}
