/*---------------------------------------------------------------------------------------------
 * Minimal Prometheus metrics bootstrap for VSClone main-process API instrumentation.
 * Exposes helpers to record request lifecycle (start / first-token / end) and default
 * process metrics. The module starts a small HTTP server exposing `/metrics` for Prometheus
 * to scrape.
 *--------------------------------------------------------------------------------------------*/

import http from 'http';
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

const DEFAULT_PORT = 9464;

const registry = new Registry();
collectDefaultMetrics({ register: registry });

// Concurrency gauge: number of in-flight chat/completion requests
const concurrentRequests = new Gauge({
  name: 'vsclone_requests_in_flight',
  help: 'Number of in-flight VSClone API requests',
  labelNames: ['vendor'],
  registers: [registry],
});

// Request duration histogram (ms)
const requestDuration = new Histogram({
  name: 'vsclone_request_duration_ms',
  help: 'E2E duration for VSClone API requests in milliseconds',
  labelNames: ['vendor', 'status'],
  buckets: [50, 100, 200, 500, 1000, 2000, 5000, 10000],
  registers: [registry],
});

// Time to first token histogram
const timeToFirstToken = new Histogram({
  name: 'vsclone_time_to_first_token_ms',
  help: 'Time from request start to first token in milliseconds',
  labelNames: ['vendor'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000],
  registers: [registry],
});

// Error counter
const errors = new Counter({
  name: 'vsclone_request_errors_total',
  help: 'Number of VSClone API errors',
  labelNames: ['vendor', 'error_type'],
  registers: [registry],
});

// Track start timestamps for open requests so we can compute durations and TTF.
const startTimes = new Map<string, number>();
const firstTokenTimes = new Map<string, number>();

function tryStartMetricsServer(port = DEFAULT_PORT) {
  try {
    const server = http.createServer(async (_req, res) => {
      if (_req.url === '/metrics') {
        try {
          const body = await registry.metrics();
          res.writeHead(200, { 'Content-Type': registry.contentType });
          res.end(body);
        } catch (e) {
          res.writeHead(500);
          res.end(String(e));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(port, '127.0.0.1');
  } catch (e) {
    // Best-effort only; avoid throwing during app init if port unavailable.
    // eslint-disable-next-line no-console
    console.warn('[vscloneMetrics] failed to start metrics server', e);
  }
}

// Initialize server eagerly.
tryStartMetricsServer();

export function recordRequestStart(requestId: string, vendor: string) {
  startTimes.set(requestId, Date.now());
  concurrentRequests.inc({ vendor }, 1);
}

export function recordFirstToken(requestId: string, vendor: string) {
  if (!startTimes.has(requestId)) {
    return;
  }
  const t0 = startTimes.get(requestId)!;
  const delta = Date.now() - t0;
  firstTokenTimes.set(requestId, Date.now());
  timeToFirstToken.observe({ vendor }, delta);
}

export function recordRequestEnd(requestId: string, vendor: string, status: 'success' | 'error' | 'aborted' = 'success') {
  const t0 = startTimes.get(requestId);
  if (t0) {
    const delta = Date.now() - t0;
    requestDuration.observe({ vendor, status }, delta);
    startTimes.delete(requestId);
  }
  firstTokenTimes.delete(requestId);
  concurrentRequests.dec({ vendor }, 1);
}

export function recordError(requestId: string | undefined, vendor: string, errorType: string) {
  errors.inc({ vendor, error_type: errorType }, 1);
  if (requestId) {
    recordRequestEnd(requestId, vendor, 'error');
  }
}

export function getRegistry() {
  return registry;
}
