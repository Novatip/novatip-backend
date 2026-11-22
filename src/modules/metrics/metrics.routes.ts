import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { register } from './metrics.service.js';
import { config } from '../../config.js';

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // Metrics endpoint is disabled by default
  if (!config.metricsEnabled) {
    return;
  }

  // Authentication hook
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = config.metricsToken;
    
    if (!token) {
      // When METRICS_TOKEN is not set, /metrics is served without authentication.
      // Callers/operators must ensure network-level isolation (e.g. firewall rules,
      // reverse proxy blocking /metrics, or binding HOST to a loopback/private interface)
      // because the Fastify server binds to config.host (defaulting to 0.0.0.0) without
      // a separate internal listener or metrics-specific bind.
      return;
    }

    // Check Bearer token
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const providedToken = authHeader.substring(7);
    if (providedToken !== token) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
  });

  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return register.metrics();
  });
}
