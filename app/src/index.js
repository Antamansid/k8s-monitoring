const express = require('express');
const { register, collectDefaultMetrics } = require('prom-client');
const logger = require('./utils/logger');
const metricsMiddleware = require('./middleware/metrics');
const apiRoutes = require('./routes/api');
const chaosRoutes = require('./routes/chaos');

const app = express();
const PORT = process.env.PORT || 3000;

// Собираем дефолтные метрики Node.js
collectDefaultMetrics({ 
  prefix: 'hackathon_',
  labels: { app: 'hackathon-service' }
});

// Middleware
app.use(express.json());
app.use(metricsMiddleware);

// Логирование запросов
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('Request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
    });
  });
  next();
});

// Health checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', (req, res) => {
  res.json({ status: 'ready' });
});

// Метрики для Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Роуты
app.use('/api', apiRoutes);
app.use('/chaos', chaosRoutes);

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  process.exit(0);
});
