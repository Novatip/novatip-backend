import { Registry, Counter, Gauge, Histogram } from "prom-client";

// Create a registry for all metrics
export const register = new Registry();

// Indexer metrics
export const indexerCursorGauge = new Gauge({
  name: "novatip_indexer_cursor_ledger",
  help: "Current indexer cursor ledger number",
  registers: [register],
});

export const indexerLagGauge = new Gauge({
  name: "novatip_indexer_lag_ledgers",
  help: "Number of ledgers the indexer is behind chain head",
  registers: [register],
});

export const indexerLastPollGauge = new Gauge({
  name: "novatip_indexer_last_successful_poll_timestamp",
  help: "Unix timestamp of last successful indexer poll",
  registers: [register],
});

export const tipsIndexedCounter = new Counter({
  name: "novatip_tips_indexed_total",
  help: "Total number of tips indexed",
  registers: [register],
});

// Webhook metrics
export const webhookDeliveriesCounter = new Counter({
  name: "novatip_webhook_deliveries_total",
  help: "Total webhook delivery attempts",
  labelNames: ["outcome"],
  registers: [register],
});

export const webhookDecryptErrorsCounter = new Counter({
  name: 'novatip_webhook_decrypt_errors_total',
  help: 'Total webhook secret decryption failures',
  registers: [register],
});

export const webhookDeliveryDuration = new Histogram({
  name: "novatip_webhook_delivery_duration_seconds",
  help: "Webhook delivery duration in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// HTTP metrics
export const httpRequestDuration = new Histogram({
  name: "novatip_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export const httpRequestsCounter = new Counter({
  name: "novatip_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

// Helper functions to update metrics
export function recordTipIndexed(): void {
  tipsIndexedCounter.inc();
}

export function updateIndexerCursor(ledger: number): void {
  indexerCursorGauge.set(ledger);
}

export function updateIndexerLag(lag: number): void {
  indexerLagGauge.set(lag);
}

export function recordSuccessfulPoll(): void {
  indexerLastPollGauge.set(Date.now() / 1000);
}

export function recordWebhookDelivery(outcome: "success" | "failure"): void {
  webhookDeliveriesCounter.inc({ outcome });
}

export function recordWebhookDecryptError(): void {
  webhookDecryptErrorsCounter.inc();
}

export function recordWebhookDuration(durationSeconds: number): void {
  webhookDeliveryDuration.observe(durationSeconds);
}

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  httpRequestsCounter.inc({ method, route, status: status.toString() });
  httpRequestDuration.observe(
    { method, route, status: status.toString() },
    durationSeconds,
  );
}
