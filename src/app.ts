import Fastify, { type FastifyInstance } from 'fastify';
import { ApiProblem } from './errors.js';
import { authenticate } from './plugins/auth.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerClientRoutes } from './routes/clients.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerHoldRoutes } from './routes/holds.js';
import { registerSimulatorRoutes } from './routes/simulator.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerDepositRoutes, registerWithdrawalRoutes } from './routes/withdrawals.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.addHook('onRequest', authenticate);

  // RFC 9457 problem+json for every error shape (PRD §A.4).
  app.setErrorHandler((err: unknown, _request, reply) => {
    if (err instanceof ApiProblem) {
      return reply.code(err.status).type('application/problem+json').send(err.toBody());
    }
    if (typeof err === 'object' && err !== null && 'validation' in err && err.validation) {
      return reply.code(400).type('application/problem+json').send({
        type: 'https://vaultchain.example/problems/validation',
        title: 'Request validation failed',
        status: 400,
        detail: err instanceof Error ? err.message : 'Invalid request',
      });
    }
    app.log.error(err);
    return reply.code(500).type('application/problem+json').send({
      type: 'https://vaultchain.example/problems/internal',
      title: 'Internal server error',
      status: 500,
    });
  });

  registerCoreRoutes(app);
  registerClientRoutes(app);
  registerAccountRoutes(app);
  registerDepositRoutes(app);
  registerWithdrawalRoutes(app);
  registerHoldRoutes(app);
  registerAuditRoutes(app);
  registerWebhookRoutes(app);
  registerSimulatorRoutes(app);

  return app;
}
