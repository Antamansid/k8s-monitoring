const { Counter, Histogram, Gauge } = require('prom-client');

// Метрики
const httpRequestsTotal = new Counter({
  name: 'hackathon_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
});

const httpRequestDuration = new Histogram({
  name: 'hackathon_http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'path', 'status_code'],
  buckets: [0.001, 0.005, 0.015, 0.05, 0.1, 0.5, 1, 5],
});

const httpRequestsInFlight = new Gauge({
  name: 'hackathon_http_requests_in_flight',
  help: 'HTTP requests in progress',
});

const errorsTotal = new Counter({
  name: 'hackathon_errors_total',
  help: 'Total errors',
  labelNames: ['type', 'path'],
});

// Бизнес-метрики (экспортируем для использования в роутах)
const ordersCreated = new Counter({
  name: 'hackathon_orders_created_total',
  help: 'Orders created',
});

const usersRegistered = new Counter({
  name: 'hackathon_users_registered_total',
  help: 'Users registered',
});

function metricsMiddleware(req, res, next) {
  if (['/metrics', '/health', '/ready'].includes(req.path)) {
    return next();
  }

  const start = process.hrtime.bigint();
  httpRequestsInFlight.inc();

  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = {
      method: req.method,
      path: normalizePath(req.path),
      status_code: res.statusCode,
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
    httpRequestsInFlight.dec();

    if (res.statusCode >= 400) {
      errorsTotal.inc({ 
        type: res.statusCode >= 500 ? 'server' : 'client',
        path: normalizePath(req.path)
      });
    }
  });

  next();
}

function normalizePath(path) {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[a-f0-9-]{36}/g, '/:uuid');
}

module.exports = metricsMiddleware;
module.exports.metrics = { ordersCreated, usersRegistered, errorsTotal };
