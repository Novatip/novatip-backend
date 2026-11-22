import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { buildServer } from '../../server.js';
import type { FastifyInstance } from 'fastify';

describe('Metrics endpoint', () => {
  describe('when metrics are disabled', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      // Metrics disabled by default
      server = await buildServer();
    });

    afterAll(async () => {
      await server.close();
    });

    it('should return 404 when disabled', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('when metrics are enabled with token', () => {
    let server: FastifyInstance;
    const testToken = 'test-metrics-token-12345';

    beforeAll(async () => {
      process.env.METRICS_ENABLED = 'true';
      process.env.METRICS_TOKEN = testToken;
      server = await buildServer();
    });

    afterAll(async () => {
      delete process.env.METRICS_ENABLED;
      delete process.env.METRICS_TOKEN;
      await server.close();
    });

    it('should return 401 without authorization header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Unauthorized' });
    });

    it('should return 403 with incorrect token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: 'Bearer wrong-token',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    it('should return metrics with correct token', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
        headers: {
          authorization: `Bearer ${testToken}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);

      const body = response.body;
      
      // Check for Prometheus format markers
      expect(body).toContain('# HELP');
      expect(body).toContain('# TYPE');
      
      // Check for our custom metrics
      expect(body).toContain('novatip_indexer_cursor_ledger');
      expect(body).toContain('novatip_indexer_lag_ledgers');
      expect(body).toContain('novatip_indexer_last_successful_poll_timestamp');
      expect(body).toContain('novatip_tips_indexed_total');
      expect(body).toContain('novatip_webhook_deliveries_total');
      expect(body).toContain('novatip_webhook_delivery_duration_seconds');
      expect(body).toContain('novatip_http_request_duration_seconds');
      expect(body).toContain('novatip_http_requests_total');
    });
  });

  describe('when metrics are enabled without token', () => {
    let server: FastifyInstance;

    beforeAll(async () => {
      process.env.METRICS_ENABLED = 'true';
      delete process.env.METRICS_TOKEN;
      server = await buildServer();
    });

    afterAll(async () => {
      delete process.env.METRICS_ENABLED;
      await server.close();
    });

    it('should allow access without authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.body).toContain('# HELP');
    });

    it('should record unmatched routes with fixed label instead of raw url', async () => {
      await server.inject({
        method: 'GET',
        url: '/nonexistent-probe-1',
      });
      await server.inject({
        method: 'GET',
        url: '/nonexistent-probe-2',
      });

      const metricsResponse = await server.inject({
        method: 'GET',
        url: '/metrics',
      });

      expect(metricsResponse.statusCode).toBe(200);
      const body = metricsResponse.body;
      expect(body).toContain('route="unmatched_route"');
      expect(body).not.toContain('/nonexistent-probe-1');
      expect(body).not.toContain('/nonexistent-probe-2');
    });
  });
});
