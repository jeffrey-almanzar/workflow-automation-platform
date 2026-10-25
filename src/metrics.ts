// Prometheus metrics for the HTTP API (the worker's metrics come from the
// Temporal SDK's own exporter, see worker.ts). Scraped from GET /metrics.

import { Controller, Get, Header } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // event loop lag, heap, GC, ...

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency, by route pattern and status code',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Express middleware, so every response is measured, including 400s from
// validation and 404s for unknown routes.
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const stop = httpDuration.startTimer();
  res.on('finish', () => {
    // The route pattern (/onboardings/:id), not the raw URL, keeps label cardinality bounded.
    const route = req.route?.path ?? 'unmatched';
    stop({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', registry.contentType)
  metrics(): Promise<string> {
    return registry.metrics();
  }
}
