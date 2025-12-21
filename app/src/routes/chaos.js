const express = require('express');
const logger = require('../utils/logger');

const router = express.Router();

// Хранилище для утечек памяти
let memoryLeak = [];
let artificialLatency = 0;

// POST /chaos/crash — роняет приложение
router.post('/crash', (req, res) => {
  const delay = parseInt(req.query.delay) || 0;
  
  logger.error('CHAOS: Crash initiated', { delay });
  res.json({ message: `Crashing in ${delay}ms` });
  
  setTimeout(() => process.exit(1), delay);
});

// POST /chaos/memory-leak — утечка памяти
router.post('/memory-leak', (req, res) => {
  const sizeMB = parseInt(req.query.size) || 50;
  const iterations = parseInt(req.query.iterations) || 1;
  
  for (let i = 0; i < iterations; i++) {
    const leak = Buffer.alloc(sizeMB * 1024 * 1024);
    leak.fill('x');
    memoryLeak.push(leak);
  }
  
  const totalMB = memoryLeak.length * sizeMB;
  logger.warn('CHAOS: Memory leak', { totalMB });
  
  res.json({ 
    message: `Leaked ${sizeMB * iterations}MB`,
    totalLeaked: `${totalMB}MB`,
  });
});

// DELETE /chaos/memory-leak — очистка
router.delete('/memory-leak', (req, res) => {
  const count = memoryLeak.length;
  memoryLeak = [];
  if (global.gc) global.gc();
  
  logger.info('CHAOS: Memory cleared');
  res.json({ message: 'Cleared', count });
});

// POST /chaos/cpu-spike — нагрузка CPU
router.post('/cpu-spike', (req, res) => {
  const durationMs = parseInt(req.query.duration) || 5000;
  
  logger.warn('CHAOS: CPU spike', { durationMs });
  
  const startTime = Date.now();
  const work = () => {
    if (Date.now() - startTime < durationMs) {
      let x = 0;
      for (let j = 0; j < 1000000; j++) {
        x += Math.sqrt(j) * Math.random();
      }
      setImmediate(work);
    }
  };
  work();
  
  res.json({ message: `CPU spike for ${durationMs}ms` });
});

// POST /chaos/latency — искусственная задержка
router.post('/latency', (req, res) => {
  artificialLatency = parseInt(req.query.delay) || 1000;
  logger.warn('CHAOS: Latency set', { latency: artificialLatency });
  res.json({ message: `Latency: ${artificialLatency}ms` });
});

// DELETE /chaos/latency
router.delete('/latency', (req, res) => {
  artificialLatency = 0;
  res.json({ message: 'Latency cleared' });
});

// GET /chaos/status
router.get('/status', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    memoryLeak: memoryLeak.length > 0,
    artificialLatency,
    memory: {
      heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    },
  });
});

module.exports = router;
