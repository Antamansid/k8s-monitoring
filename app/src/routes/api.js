const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { metrics } = require('../middleware/metrics');

const router = express.Router();

// Простая "база данных" в памяти
const users = new Map();
const orders = new Map();

// GET /api/users
router.get('/users', (req, res) => {
  res.json({ 
    users: Array.from(users.values()), 
    count: users.size 
  });
});

// GET /api/users/:id
router.get('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

// POST /api/users
router.post('/users', (req, res) => {
  const { name, email } = req.body;
  
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email required' });
  }

  const user = {
    id: uuidv4(),
    name,
    email,
    createdAt: new Date().toISOString(),
  };
  
  users.set(user.id, user);
  metrics.usersRegistered.inc();
  
  logger.info('User created', { userId: user.id });
  res.status(201).json(user);
});

// GET /api/orders
router.get('/orders', (req, res) => {
  res.json({ 
    orders: Array.from(orders.values()), 
    count: orders.size 
  });
});

// POST /api/orders
router.post('/orders', (req, res) => {
  const { userId, items, total } = req.body;
  
  if (!userId || !items) {
    return res.status(400).json({ error: 'userId and items required' });
  }

  const order = {
    id: uuidv4(),
    userId,
    items,
    total: total || 0,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  
  orders.set(order.id, order);
  metrics.ordersCreated.inc();
  
  logger.info('Order created', { orderId: order.id });
  res.status(201).json(order);
});

// GET /api/slow — медленный эндпоинт
router.get('/slow', async (req, res) => {
  const delay = parseInt(req.query.delay) || 2000;
  await new Promise(resolve => setTimeout(resolve, delay));
  res.json({ message: 'Slow response', delay });
});

// GET /api/random-error — случайные ошибки
router.get('/random-error', (req, res) => {
  const errorRate = parseFloat(req.query.rate) || 0.3;
  
  if (Math.random() < errorRate) {
    return res.status(500).json({ error: 'Random error' });
  }
  
  res.json({ message: 'Success' });
});

module.exports = router;
