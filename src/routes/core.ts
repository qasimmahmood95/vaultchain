import type { FastifyInstance } from 'fastify';

export function registerCoreRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/me', async (request) => ({
    apiKeyId: request.actor.apiKeyId,
    role: request.actor.role,
    clientId: request.actor.clientId,
  }));
}
