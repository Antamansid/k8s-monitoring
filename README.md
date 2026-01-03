# Хакатон k8s мониторинг

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Yandex Cloud                                │
│                                                                      │
│  ┌──────────────────┐                                               │
│  │   Рабочая VM     │ ◄── SSH с вашего компьютера                   │
│  │   (Ubuntu SSD)   │     Здесь: yc, kubectl, docker, helm, k6      │
│  └────────┬─────────┘                                               │
│           │                                                          │
│  ┌────────┼──────────────────────────────────────────────────────┐  │
│  │        │           Managed Kubernetes                          │  │
│  │        ▼                                                       │  │
│  │  ┌───────────┐     ┌─────────┐  ┌─────────┐                   │  │
│  │  │  Ingress  │────▶│  Pod 1  │  │  Pod 2  │ ◄── HPA           │  │
│  │  │(1 LoadBal)│     │   App   │  │   App   │                   │  │
│  │  └───────────┘     └────┬────┘  └────┬────┘                   │  │
│  │       │                 │            │                         │  │
│  │       │    ┌────────────┴────────────┘                        │  │
│  │       │    ▼                                                   │  │
│  │       │  ┌──────────────────────────────────────────┐         │  │
│  │       │  │            Monitoring Stack               │         │  │
│  │       │  │  Prometheus ─── Alertmanager ──▶ Telegram │         │  │
│  │       │  │  Grafana                                  │         │  │
│  │       │  └──────────────────────────────────────────┘         │  │
│  │       │                                                        │  │
│  │  ┌────┴─────┐                                                  │  │
│  │  │   NAT    │───▶ Container Registry (образы)                  │  │
│  │  │ Gateway  │───▶ Интернет (зависимости)                       │  │
│  │  └──────────┘                                                  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Этап 0: Подготовка репозитория (на своём компьютере)

### Шаг 0.1: Создаём репозиторий на GitHub

https://github.com/new

- Имя: `k8s-monitoring-hackathon`
- Public → Create

### Шаг 0.2: Клонируем и создаём структуру

```bash
git clone https://github.com/<username>/k8s-monitoring-hackathon.git
cd k8s-monitoring-hackathon

mkdir -p app/src/{routes,middleware,utils}
mkdir -p k8s
mkdir -p monitoring
mkdir -p load-tests
```

### Шаг 0.3: Создаём файлы приложения

**app/package.json**

```json
{
  "name": "hackathon-observability",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "prom-client": "^15.1.0",
    "winston": "^3.11.0",
    "uuid": "^9.0.1"
  }
}
```

**app/src/index.js**

```javascript
const express = require('express');
const { register, collectDefaultMetrics } = require('prom-client');
const logger = require('./utils/logger');
const metricsMiddleware = require('./middleware/metrics');
const apiRoutes = require('./routes/api');
const chaosRoutes = require('./routes/chaos');

const app = express();
const PORT = process.env.PORT || 3000;

collectDefaultMetrics({ 
  prefix: 'hackathon_',
  labels: { app: 'hackathon-service' }
});

app.use(express.json());
app.use(metricsMiddleware);

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/ready', (req, res) => {
  res.json({ status: 'ready' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/api', apiRoutes);
app.use('/chaos', chaosRoutes);

app.use((err, req, res, next) => {
  logger.error('Error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  process.exit(0);
});
```

**app/src/utils/logger.js**

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { 
    service: 'hackathon',
    pod: process.env.HOSTNAME || 'local',
  },
  transports: [
    new winston.transports.Console(),
  ],
});

module.exports = logger;
```

**app/src/middleware/metrics.js**

```javascript
const { Counter, Histogram, Gauge } = require('prom-client');

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
```

**app/src/routes/api.js**

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { metrics } = require('../middleware/metrics');

const router = express.Router();

const users = new Map();
const orders = new Map();

router.get('/users', (req, res) => {
  res.json({ 
    users: Array.from(users.values()), 
    count: users.size 
  });
});

router.get('/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json(user);
});

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

router.get('/orders', (req, res) => {
  res.json({ 
    orders: Array.from(orders.values()), 
    count: orders.size 
  });
});

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

router.get('/slow', async (req, res) => {
  const delay = parseInt(req.query.delay) || 2000;
  await new Promise(resolve => setTimeout(resolve, delay));
  res.json({ message: 'Slow response', delay });
});

router.get('/random-error', (req, res) => {
  const errorRate = parseFloat(req.query.rate) || 0.3;
  
  if (Math.random() < errorRate) {
    return res.status(500).json({ error: 'Random error' });
  }
  
  res.json({ message: 'Success' });
});

module.exports = router;
```

**app/src/routes/chaos.js**

```javascript
const express = require('express');
const logger = require('../utils/logger');

const router = express.Router();

let memoryLeak = [];
let artificialLatency = 0;

router.post('/crash', (req, res) => {
  const delay = parseInt(req.query.delay) || 0;
  logger.error('CHAOS: Crash initiated', { delay });
  res.json({ message: `Crashing in ${delay}ms` });
  setTimeout(() => process.exit(1), delay);
});

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

router.delete('/memory-leak', (req, res) => {
  const count = memoryLeak.length;
  memoryLeak = [];
  if (global.gc) global.gc();
  
  logger.info('CHAOS: Memory cleared');
  res.json({ message: 'Cleared', count });
});

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

router.post('/latency', (req, res) => {
  artificialLatency = parseInt(req.query.delay) || 1000;
  logger.warn('CHAOS: Latency set', { latency: artificialLatency });
  res.json({ message: `Latency: ${artificialLatency}ms` });
});

router.delete('/latency', (req, res) => {
  artificialLatency = 0;
  res.json({ message: 'Latency cleared' });
});

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
```

**app/Dockerfile**

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3000

CMD ["node", "--expose-gc", "src/index.js"]
```

**.gitignore**

```
node_modules/
.env
*.log
.DS_Store
```

### Шаг 0.4: Пушим в GitHub

```bash
git add .
git commit -m "Initial commit: Node.js app with metrics"
git push origin main
```

## Этап 1: Создаём VM в Yandex Cloud

### Шаг 1.1: Через консоль Yandex Cloud

https://console.yandex.cloud/

**Compute Cloud → Создать ВМ**

Настройки:
- Имя: `hackathon-vm`
- Зона: `ru-central1-a`
- ОС: Ubuntu 22.04
- vCPU: 2, RAM: 4 ГБ
- Диск: 30 ГБ SSD (для скорости работы)
- Публичный IP: Авто
- SSH-ключ: вставить свой (`cat ~/.ssh/id_rsa.pub`)
- Создать

### Шаг 1.2: Подключаемся

```bash
ssh ubuntu@<VM_IP>
```

## Этап 2: Настраиваем VM

### Шаг 2.1: Устанавливаем инструменты

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git jq
```

**Docker:** https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository

После установки:

```bash
# Добавляем текущего пользователя в группу docker (чтобы не использовать sudo)
sudo usermod -aG docker $USER

# Активируем группу docker для текущей сессии без перелогина
newgrp docker

# Проверяем версию Docker
docker --version

# Тестовый запуск контейнера для проверки работы
docker run hello-world
```

**Node.js 20:** https://nodejs.org/en/download

```bash
# Или быстрый способ:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

**kubectl:** https://kubernetes.io/ru/docs/tasks/tools/install-kubectl/

**Helm:** https://helm.sh/docs/intro/install/#from-apt-debianubuntu

**k6:** https://grafana.com/docs/k6/latest/set-up/install-k6/#linux

**Yandex Cloud CLI:** https://yandex.cloud/ru/docs/cli/quickstart

### Шаг 2.2: Авторизуемся в Yandex Cloud

Следуем инструкции: https://yandex.cloud/ru/docs/cli/quickstart

```bash
yc init
yc config list
```

### Шаг 2.3: Клонируем репозиторий

```bash
cd ~
git clone https://github.com/<username>/k8s-monitoring-hackathon.git
cd k8s-monitoring-hackathon
```

### Шаг 2.4: Тестируем приложение локально

```bash
cd app
npm install
npm start
```

В другой сессии:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/metrics | head -20
```

Останавливаем: `Ctrl+C`

## Этап 3: Настраиваем Yandex Cloud инфраструктуру

### Шаг 3.1: Сохраняем переменные

```bash
export FOLDER_ID=$(yc config get folder-id)
echo "export FOLDER_ID=$FOLDER_ID" >> ~/.bashrc
echo "Folder ID: $FOLDER_ID"
```

### Шаг 3.2: Создаём сервисный аккаунт

```bash
yc iam service-account create --name hackathon-sa

export SA_ID=$(yc iam service-account get --name hackathon-sa --format json | jq -r .id)
echo "export SA_ID=$SA_ID" >> ~/.bashrc
echo "Service Account ID: $SA_ID"

# Назначаем роли сервисному аккаунту
# editor - для управления ресурсами кластера
yc resource-manager folder add-access-binding --id $FOLDER_ID \
  --role editor \
  --subject serviceAccount:$SA_ID

# container-registry.images.puller - для скачивания образов из Registry
yc resource-manager folder add-access-binding --id $FOLDER_ID \
  --role container-registry.images.puller \
  --subject serviceAccount:$SA_ID
```

### Шаг 3.3: Создаём Container Registry

```bash
yc container registry create --name hackathon-registry

export REGISTRY_ID=$(yc container registry get --name hackathon-registry --format json | jq -r .id)
echo "export REGISTRY_ID=$REGISTRY_ID" >> ~/.bashrc
echo "Registry ID: $REGISTRY_ID"

yc container registry configure-docker
```

### Шаг 3.4: Создаём сеть с NAT Gateway

**Зачем нужен NAT Gateway?**

NAT Gateway обеспечивает **исходящий** интернет-трафик из приватных подсетей:
- ✅ Поды скачивают Docker образы из Registry
- ✅ Поды обращаются к внешним API
- ✅ Обновления системных пакетов
- 🔒 Входящий трафик извне **блокируется** (доступ только через Ingress)

**Схема сетевой безопасности:**

```
┌─────────────────────────────────────────┐
│            Интернет                      │
└───────▲────────────────────────┬─────────┘
        │                        │
        │ Входящий               │ Исходящий
        │ (через LB)             │ (через NAT)
        │                        │
┌───────┴────────┐      ┌────────▼─────────┐
│   LoadBalancer │      │   NAT Gateway    │
│   (Ingress)    │      │  (один IP)       │
└───────┬────────┘      └──────────────────┘
        │                        ▲
        │                        │
┌───────▼─────────────────────────┴────────┐
│         Kubernetes кластер                │
│     (приватные IP: 10.1.x.x)             │
│                                           │
│  ┌────────┐  ┌────────┐  ┌────────┐     │
│  │ Pod 1  │  │ Pod 2  │  │ Pod N  │     │
│  └────────┘  └────────┘  └────────┘     │
└───────────────────────────────────────────┘
```

```bash
# Создаём виртуальную сеть (VPC)
yc vpc network create --name hackathon-network

export NETWORK_ID=$(yc vpc network get --name hackathon-network --format json | jq -r .id)
echo "export NETWORK_ID=$NETWORK_ID" >> ~/.bashrc

# Создаём NAT Gateway для исходящего трафика
yc vpc gateway create --name hackathon-nat

export GATEWAY_ID=$(yc vpc gateway get --name hackathon-nat --format json | jq -r .id)
echo "export GATEWAY_ID=$GATEWAY_ID" >> ~/.bashrc

# Создаём таблицу маршрутизации (весь исходящий трафик → NAT Gateway)
yc vpc route-table create \
  --name hackathon-routes \
  --network-id $NETWORK_ID \
  --route destination=0.0.0.0/0,gateway-id=$GATEWAY_ID

# Создаём подсеть с приватными IP-адресами
yc vpc subnet create \
  --name hackathon-subnet \
  --zone ru-central1-a \
  --range 10.1.0.0/16 \
  --network-name hackathon-network \
  --route-table-name hackathon-routes
```

### Шаг 3.5: Создаём Kubernetes кластер

Команда сама дождётся создания кластера (5-10 минут).

```bash
yc managed-kubernetes cluster create \
  --name hackathon-cluster \
  --zone ru-central1-a \
  --network-name hackathon-network \
  --public-ip \
  --service-account-name hackathon-sa \
  --node-service-account-name hackathon-sa
```

### Шаг 3.6: Создаём группу узлов

⚠️ Возможные проблемы с квотами:

- Ошибка SSD → используйте `--disk-type network-hdd`
- Ошибка сети → удалите неиспользуемые VPC
- Ошибка CPU/RAM → удалите другие VM

```bash
yc managed-kubernetes node-group create \
  --name hackathon-nodes \
  --cluster-name hackathon-cluster \
  --platform standard-v2 \
  --cores 2 \
  --memory 4 \
  --core-fraction 50 \
  --disk-type network-hdd \
  --disk-size 64 \
  --fixed-size 2 \
  --location zone=ru-central1-a,subnet-name=hackathon-subnet

# Ждём RUNNING
watch yc managed-kubernetes node-group list
```

### Шаг 3.7: Подключаемся к кластеру

```bash
yc managed-kubernetes cluster get-credentials hackathon-cluster --external

kubectl cluster-info
kubectl get nodes
```

## Этап 4: Деплоим приложение

### Шаг 4.1: Собираем и пушим образ

```bash
cd ~/k8s-monitoring-hackathon/app

docker build -t cr.yandex/$REGISTRY_ID/hackathon-app:v1 .
docker push cr.yandex/$REGISTRY_ID/hackathon-app:v1

# Проверяем
yc container image list --repository-name $REGISTRY_ID/hackathon-app
```

### Шаг 4.2: Создаём Kubernetes манифесты

```bash
cd ~/k8s-monitoring-hackathon

cat > k8s/deployment.yaml << EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hackathon-app
  labels:
    app: hackathon-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: hackathon-app
  template:
    metadata:
      labels:
        app: hackathon-app
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: app
        image: cr.yandex/$REGISTRY_ID/hackathon-app:v1
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: NODE_ENV
          value: "production"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
EOF

cat > k8s/service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: hackathon-app
  labels:
    app: hackathon-app
spec:
  type: ClusterIP
  ports:
  - port: 80
    targetPort: 3000
    name: http
  selector:
    app: hackathon-app
EOF

cat > k8s/hpa.yaml << 'EOF'
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: hackathon-app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: hackathon-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60
EOF
```

### Шаг 4.3: Деплоим

```bash
kubectl apply -f k8s/
kubectl get pods -w
```

## Этап 5: Настраиваем мониторинг и Ingress

### Шаг 5.1: Устанавливаем Ingress Controller

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace

# Ждём внешний IP
kubectl get svc -n ingress-nginx ingress-nginx-controller -w
```

### Шаг 5.2: Сохраняем IP

```bash
export INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "export INGRESS_IP=$INGRESS_IP" >> ~/.bashrc
echo "Ingress IP: $INGRESS_IP"
```

### Шаг 5.3: Устанавливаем Prometheus Stack

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

kubectl create namespace monitoring

mkdir -p monitoring

cat > monitoring/prometheus-values.yaml << EOF
prometheus:
  prometheusSpec:
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
    externalUrl: http://$INGRESS_IP/prometheus
    routePrefix: /prometheus

alertmanager:
  alertmanagerSpec:
    externalUrl: http://$INGRESS_IP/alertmanager
    routePrefix: /alertmanager

grafana:
  grafana.ini:
    server:
      root_url: http://$INGRESS_IP/grafana
      serve_from_sub_path: true

defaultRules:
  rules:
    kubeControllerManager: false
    kubeScheduler: false
    kubeProxy: false
EOF

helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f monitoring/prometheus-values.yaml

kubectl get pods -n monitoring -w
```

### Шаг 5.4: Создаём ServiceMonitor

```bash
cat > k8s/servicemonitor.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hackathon-app
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: hackathon-app
  namespaceSelector:
    matchNames:
      - default
  endpoints:
  - port: http
    path: /metrics
    interval: 15s
EOF

kubectl apply -f k8s/servicemonitor.yaml
```

### Шаг 5.5: Создаём Ingress

```bash
cat > k8s/ingress.yaml << 'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: hackathon-app-ingress
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  rules:
  - http:
      paths:
      - path: /api
        pathType: Prefix
        backend:
          service:
            name: hackathon-app
            port:
              number: 80
      - path: /health
        pathType: Exact
        backend:
          service:
            name: hackathon-app
            port:
              number: 80
      - path: /metrics
        pathType: Exact
        backend:
          service:
            name: hackathon-app
            port:
              number: 80
      - path: /chaos
        pathType: Prefix
        backend:
          service:
            name: hackathon-app
            port:
              number: 80
EOF

cat > monitoring/ingress.yaml << 'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: monitoring-ingress
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
spec:
  ingressClassName: nginx
  rules:
  - http:
      paths:
      - path: /grafana
        pathType: Prefix
        backend:
          service:
            name: prometheus-grafana
            port:
              number: 80
      - path: /prometheus
        pathType: Prefix
        backend:
          service:
            name: prometheus-kube-prometheus-prometheus
            port:
              number: 9090
      - path: /alertmanager
        pathType: Prefix
        backend:
          service:
            name: prometheus-kube-prometheus-alertmanager
            port:
              number: 9093
EOF

kubectl apply -f k8s/ingress.yaml
kubectl apply -f monitoring/ingress.yaml
```

### Шаг 5.6: Проверяем

```bash
echo ""
echo "=========================================="
echo "Приложение: http://$INGRESS_IP/health"
echo "Grafana:    http://$INGRESS_IP/grafana"
echo "Prometheus: http://$INGRESS_IP/prometheus"
echo "Alertmanager: http://$INGRESS_IP/alertmanager"
echo "=========================================="

# Тесты
curl -s http://$INGRESS_IP/health
curl -s http://$INGRESS_IP/prometheus/-/ready
curl -s http://$INGRESS_IP/alertmanager/-/ready
```

### Шаг 5.7: Получаем пароль Grafana

```bash
kubectl get secret -n monitoring prometheus-grafana \
  -o jsonpath="{.data.admin-password}" | base64 -d && echo
```

- Username: `admin`
- Password: (из команды выше)

### Шаг 5.8: Автоматическое создание Dashboard в Grafana

#### Шаг 5.8.1: Получаем UID Prometheus datasource

```bash
# Получаем пароль Grafana
GRAFANA_PASS=$(kubectl get secret -n monitoring prometheus-grafana -o jsonpath="{.data.admin-password}" | base64 -d)

# Получаем UID Prometheus datasource
PROMETHEUS_UID=$(curl -s -u "admin:$GRAFANA_PASS" "http://$INGRESS_IP/grafana/api/datasources" | jq -r '.[] | select(.type=="prometheus") | .uid')

# Проверяем
echo "Prometheus UID: $PROMETHEUS_UID"

# Сохраняем в .bashrc
echo "export PROMETHEUS_UID=$PROMETHEUS_UID" >> ~/.bashrc
```

#### Шаг 5.8.2: Создаём JSON файл Dashboard

```bash
mkdir -p monitoring/grafana

cat > monitoring/grafana/hackathon-dashboard.json << EOF
{
  "annotations": {"list": []},
  "editable": true,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "links": [],
  "liveNow": false,
  "panels": [
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "line"}
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 50},
              {"color": "red", "value": 200}
            ]
          },
          "unit": "reqps"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 0},
      "id": 1,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(rate(hackathon_http_requests_total[1m]))",
          "legendFormat": "Total RPS",
          "range": true, "refId": "A"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum by (path) (rate(hackathon_http_requests_total[1m]))",
          "legendFormat": "{{path}}",
          "range": true, "refId": "B"
        }
      ],
      "title": "📈 Request Rate (RPS)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "line"}
          },
          "mappings": [],
          "max": 100, "min": 0,
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 5},
              {"color": "red", "value": 10}
            ]
          },
          "unit": "percent"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 0},
      "id": 2,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(rate(hackathon_http_requests_total{status_code=~\"5..\"}[1m])) / sum(rate(hackathon_http_requests_total[1m])) * 100",
          "legendFormat": "Error Rate %",
          "range": true, "refId": "A"
        }
      ],
      "title": "🚨 Error Rate (%)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "line"}
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 0.5},
              {"color": "red", "value": 1}
            ]
          },
          "unit": "s"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 8},
      "id": 3,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "histogram_quantile(0.50, sum(rate(hackathon_http_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p50", "range": true, "refId": "A"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "histogram_quantile(0.95, sum(rate(hackathon_http_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p95", "range": true, "refId": "B"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "histogram_quantile(0.99, sum(rate(hackathon_http_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p99", "range": true, "refId": "C"
        }
      ],
      "title": "⏱️ Response Time (Latency)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "line"}
          },
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 400},
              {"color": "red", "value": 480}
            ]
          },
          "unit": "decmbytes"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 8},
      "id": 4,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum by (pod) (container_memory_working_set_bytes{container=\"app\"}) / 1024 / 1024",
          "legendFormat": "{{pod}}", "range": true, "refId": "A"
        }
      ],
      "title": "🧠 Memory Usage (MB)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "red", "value": null},
              {"color": "yellow", "value": 2},
              {"color": "green", "value": 3}
            ]
          },
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 0, "y": 16},
      "id": 5,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "count(kube_pod_status_ready{condition=\"true\", pod=~\"hackathon-app.*\"})",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "🟢 Ready Pods",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 1},
              {"color": "red", "value": 3}
            ]
          },
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 4, "y": 16},
      "id": 6,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(increase(kube_pod_container_status_restarts_total{container=\"app\"}[1h]))",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "🔄 Restarts (1h)",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 50},
              {"color": "red", "value": 200}
            ]
          },
          "unit": "reqps"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 8, "y": 16},
      "id": 7,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(rate(hackathon_http_requests_total[1m]))",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "📊 Current RPS",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 5},
              {"color": "red", "value": 10}
            ]
          },
          "unit": "percent"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 12, "y": 16},
      "id": 8,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(rate(hackathon_http_requests_total{status_code=~\"5..\"}[1m])) / sum(rate(hackathon_http_requests_total[1m])) * 100",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "❌ Error Rate",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 0.5},
              {"color": "red", "value": 1}
            ]
          },
          "unit": "s"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 16, "y": 16},
      "id": 9,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "histogram_quantile(0.95, sum(rate(hackathon_http_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "⏱️ Latency p95",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "thresholds"},
          "mappings": [],
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}]},
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {"h": 4, "w": 4, "x": 20, "y": 16},
      "id": 10,
      "options": {
        "colorMode": "value", "graphMode": "area", "justifyMode": "auto", "orientation": "auto",
        "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": false},
        "textMode": "auto"
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum(hackathon_http_requests_in_flight)",
          "legendFormat": "__auto", "range": true, "refId": "A"
        }
      ],
      "title": "🔄 In-Flight",
      "type": "stat"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "off"}
          },
          "mappings": [],
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}]},
          "unit": "percent"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 0, "y": 20},
      "id": 11,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum by (pod) (rate(container_cpu_usage_seconds_total{container=\"app\"}[1m])) * 100",
          "legendFormat": "{{pod}}", "range": true, "refId": "A"
        }
      ],
      "title": "💻 CPU Usage (%)",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "line", "fillOpacity": 10, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 2, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "none"},
            "thresholdsStyle": {"mode": "off"}
          },
          "mappings": [],
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}]},
          "unit": "short"
        },
        "overrides": []
      },
      "gridPos": {"h": 8, "w": 12, "x": 12, "y": 20},
      "id": 12,
      "options": {
        "legend": {"calcs": ["last", "max"], "displayMode": "table", "placement": "bottom", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "kube_horizontalpodautoscaler_status_desired_replicas{horizontalpodautoscaler=\"hackathon-app-hpa\"}",
          "legendFormat": "Desired", "range": true, "refId": "A"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "kube_horizontalpodautoscaler_status_current_replicas{horizontalpodautoscaler=\"hackathon-app-hpa\"}",
          "legendFormat": "Current", "range": true, "refId": "B"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "kube_horizontalpodautoscaler_spec_min_replicas{horizontalpodautoscaler=\"hackathon-app-hpa\"}",
          "legendFormat": "Min", "range": true, "refId": "C"
        },
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "kube_horizontalpodautoscaler_spec_max_replicas{horizontalpodautoscaler=\"hackathon-app-hpa\"}",
          "legendFormat": "Max", "range": true, "refId": "D"
        }
      ],
      "title": "📈 HPA Scaling",
      "type": "timeseries"
    },
    {
      "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
      "fieldConfig": {
        "defaults": {
          "color": {"mode": "palette-classic"},
          "custom": {
            "axisCenteredZero": false, "axisColorMode": "text", "axisPlacement": "auto",
            "barAlignment": 0, "drawStyle": "bars", "fillOpacity": 100, "gradientMode": "none",
            "hideFrom": {"legend": false, "tooltip": false, "viz": false},
            "lineInterpolation": "linear", "lineWidth": 1, "pointSize": 5,
            "scaleDistribution": {"type": "linear"}, "showPoints": "never", "spanNulls": false,
            "stacking": {"group": "A", "mode": "normal"},
            "thresholdsStyle": {"mode": "off"}
          },
          "mappings": [],
          "thresholds": {"mode": "absolute", "steps": [{"color": "green", "value": null}]},
          "unit": "short"
        },
        "overrides": [
          {"matcher": {"id": "byRegexp", "options": ".*5.."}, "properties": [{"id": "color", "value": {"fixedColor": "red", "mode": "fixed"}}]},
          {"matcher": {"id": "byRegexp", "options": ".*4.."}, "properties": [{"id": "color", "value": {"fixedColor": "yellow", "mode": "fixed"}}]},
          {"matcher": {"id": "byRegexp", "options": ".*2.."}, "properties": [{"id": "color", "value": {"fixedColor": "green", "mode": "fixed"}}]}
        ]
      },
      "gridPos": {"h": 8, "w": 24, "x": 0, "y": 28},
      "id": 13,
      "options": {
        "legend": {"calcs": ["sum"], "displayMode": "table", "placement": "right", "showLegend": true},
        "tooltip": {"mode": "multi", "sort": "none"}
      },
      "targets": [
        {
          "datasource": {"type": "prometheus", "uid": "$PROMETHEUS_UID"},
          "editorMode": "code",
          "expr": "sum by (status_code) (increase(hackathon_http_requests_total[1m]))",
          "legendFormat": "{{status_code}}", "range": true, "refId": "A"
        }
      ],
      "title": "📊 Requests by Status Code",
      "type": "timeseries"
    }
  ],
  "refresh": "5s",
  "schemaVersion": 38,
  "style": "dark",
  "tags": ["hackathon", "nodejs", "kubernetes"],
  "templating": {"list": []},
  "time": {"from": "now-15m", "to": "now"},
  "timepicker": {},
  "timezone": "",
  "title": "Hackathon App Dashboard",
  "uid": "hackathon-dashboard",
  "version": 1,
  "weekStart": ""
}
EOF
```

#### Шаг 5.8.3: Создаём и применяем ConfigMap

```bash
# Создаём ConfigMap из JSON файла
kubectl create configmap hackathon-dashboard \
  --from-file=hackathon-dashboard.json=monitoring/grafana/hackathon-dashboard.json \
  --namespace monitoring \
  --dry-run=client -o yaml | \
  kubectl label --local -f - grafana_dashboard=1 --dry-run=client -o yaml | \
  kubectl apply -f -

```

#### Шаг 5.8.4: Проверяем

```bash
# Проверяем что ConfigMap создан
kubectl get configmap -n monitoring hackathon-dashboard

# Ждём 30 секунд (Grafana sidecar подхватывает новые dashboards)
echo "Ждём 30 секунд, пока Grafana подхватит Dashboard..."
sleep 30

echo ""
echo "=========================================="
echo "✅ Dashboard создан!"
echo ""
echo "Откройте в браузере:"
echo "http://$INGRESS_IP/grafana/d/hackathon-dashboard"
echo ""
echo "Login: admin"
echo "Password: (получили в шаге 5.7)"
echo "=========================================="
```

**Что содержит Dashboard (13 панелей):**
- 📈 **Request Rate (RPS)** — общий и по endpoint'ам
- 🚨 **Error Rate (%)** — процент ошибок
- ⏱️ **Response Time** — p50, p95, p99 перцентили латентности
- 🧠 **Memory Usage** — потребление памяти по подам
- 💻 **CPU Usage** — загрузка CPU по подам
- 📈 **HPA Scaling** — desired/current/min/max реплики
- 📊 **Current RPS** — текущее значение (меняет цвет при превышении порогов)
- ❌ **Error Rate** — текущий процент ошибок
- ⏱️ **Latency p95** — текущая задержка 95-го перцентиля
- 🟢 **Ready Pods** — количество готовых подов
- 🔄 **Restarts (1h)** — перезапуски за последний час
- 🔄 **In-Flight** — количество запросов в обработке прямо сейчас
- 📊 **Requests by Status Code** — распределение по HTTP кодам (2xx зелёный, 4xx жёлтый, 5xx красный)

💡 **Совет:** Dashboard обновляется каждые 5 секунд автоматически, идеально для демонстрации в реальном времени!

## Этап 6: Настраиваем алерты в Telegram

### Шаг 6.1: Создаём Telegram бота

1. Открой @BotFather в Telegram
2. Отправь `/newbot`
3. Получи токен
4. Напиши чего-нибудь боту (ссылка будет в ответе от @BotFather). К примеру `Hello!`.

### Шаг 6.2: Получаем Chat ID

```bash
# Сначала напиши боту сообщение!
export TELEGRAM_TOKEN="ВСТАВЬ_ТОКЕН"
echo "export TELEGRAM_TOKEN=$TELEGRAM_TOKEN" >> ~/.bashrc

curl -s "https://api.telegram.org/bot$TELEGRAM_TOKEN/getUpdates" | jq '.result[0].message.chat.id'

export CHAT_ID="ВСТАВЬ_CHAT_ID"
echo "export CHAT_ID=$CHAT_ID" >> ~/.bashrc
```

### Шаг 6.3: Создаём правила алертов

```bash
cat > monitoring/prometheus-rules.yaml << 'EOF'
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hackathon-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
  - name: hackathon
    rules:
    - alert: HighRequestRate
      expr: sum(rate(hackathon_http_requests_total[1m])) > 50
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "High RPS detected"
        description: "RPS: {{ $value | printf \"%.0f\" }}"

    - alert: VeryHighRequestRate
      expr: sum(rate(hackathon_http_requests_total[1m])) > 200
      for: 30s
      labels:
        severity: critical
      annotations:
        summary: "🔥 Very high RPS!"
        description: "RPS: {{ $value | printf \"%.0f\" }}"

    - alert: HighErrorRate
      expr: |
        (sum(rate(hackathon_http_requests_total{status_code=~"5.."}[5m])) /
        sum(rate(hackathon_http_requests_total[5m]))) > 0.05
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "High error rate"
        description: "Error rate above 5%"

    - alert: PodRestarting
      expr: increase(kube_pod_container_status_restarts_total{container="app"}[5m]) > 0
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "💀 Pod {{ $labels.pod }} restarted!"

    - alert: HighLatency
      expr: |
        histogram_quantile(0.95,
          sum(rate(hackathon_http_request_duration_seconds_bucket[5m])) by (le)) > 1
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "⏱️ High latency p95"
EOF

kubectl apply -f monitoring/prometheus-rules.yaml
```

### Шаг 6.4: Настраиваем Alertmanager

```bash
cat > monitoring/alertmanager-secret.yaml << EOF
apiVersion: v1
kind: Secret
metadata:
  name: alertmanager-prometheus-kube-prometheus-alertmanager
  namespace: monitoring
stringData:
  alertmanager.yaml: |
    global:
      resolve_timeout: 5m
    route:
      receiver: 'telegram'
      group_by: ['alertname']
      group_wait: 10s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - match:
            severity: critical
          receiver: 'telegram'
          group_wait: 0s
    receivers:
    - name: 'telegram'
      telegram_configs:
      - bot_token: '$TELEGRAM_TOKEN'
        chat_id: $CHAT_ID
        parse_mode: 'HTML'
        message: |
          {{ if eq .Status "firing" }}🔴{{ else }}🟢{{ end }} <b>{{ .Status | toUpper }}</b>
          {{ range .Alerts }}
          <b>{{ .Labels.alertname }}</b>
          {{ .Annotations.summary }}
          {{ .Annotations.description }}
          {{ end }}
EOF

kubectl apply -f monitoring/alertmanager-secret.yaml
kubectl rollout restart statefulset -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager
```

## Этап 7: Тестируем!

### Шаг 7.1: Создаём нагрузочные тесты

```bash
mkdir -p load-tests

cat > load-tests/stress.js << 'EOF'
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 20 },
    { duration: '30s', target: 100 },
    { duration: '1m', target: 300 },
    { duration: '30s', target: 0 },
  ],
};

const BASE_URL = __ENV.BASE_URL;

export default function () {
  const res = http.get(`${BASE_URL}/api/users`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
EOF

cat > load-tests/errors.js << 'EOF'
import http from 'k6/http';

export const options = {
  vus: 30,
  duration: '2m',
};

const BASE_URL = __ENV.BASE_URL;

export default function () {
  http.get(`${BASE_URL}/api/random-error?rate=0.3`);
}
EOF
```

### Шаг 7.2: Открываем для наблюдения

**В браузере (откройте в отдельных вкладках):**

```bash
echo "=========================================="
echo "Dashboard:  http://$INGRESS_IP/grafana/d/hackathon-dashboard"
echo "Alerts:     http://$INGRESS_IP/prometheus/alerts"
echo "Telegram:   Ждём уведомления от бота"
echo "=========================================="
```

- **Dashboard Grafana** — здесь видим всё: RPS, ошибки, latency, CPU, память, HPA
- **Prometheus Alerts** — текущие активные алерты
- **Telegram** — получаем уведомления

**В терминале (в отдельных окнах):**

```bash
# Терминал 1: Следим за подами
watch kubectl get pods -l app=hackathon-app

# Терминал 2: Следим за HPA
watch kubectl get hpa
```

### Шаг 7.3: Тест на RPS

```bash
k6 run -e BASE_URL=http://$INGRESS_IP load-tests/stress.js
```

**Наблюдаем на Dashboard:**
- 📈 Request Rate (RPS) — график вырастет до 200+ RPS
- 📊 Current RPS — циферка станет жёлтой/красной
- 📈 HPA Scaling — поды начнут масштабироваться
- 🟢 Ready Pods — количество подов увеличится

**Ожидаем:** алерт `HighRequestRate` / `VeryHighRequestRate` в Telegram.

### Шаг 7.4: Тест на ошибки

```bash
k6 run -e BASE_URL=http://$INGRESS_IP load-tests/errors.js
```

**Наблюдаем на Dashboard:**
- 🚨 Error Rate (%) — график поднимется выше 5%
- ❌ Error Rate — циферка станет жёлтой/красной
- 📊 Requests by Status Code — появятся красные столбцы (5xx ошибки)

**Ожидаем:** алерт `HighErrorRate` в Telegram.

### Шаг 7.5: Роняем под

```bash
curl -X POST "http://$INGRESS_IP/chaos/crash?delay=1000"
kubectl get pods -l app=hackathon-app -w
```

**Наблюдаем на Dashboard:**
- 🟢 Ready Pods — временно уменьшится на 1
- 🔄 Restarts (1h) — счётчик увеличится
- В терминале — под перейдёт в состояние `CrashLoopBackOff`, затем восстановится

**Ожидаем:** алерт `PodRestarting` в Telegram.

### Шаг 7.6: Утечка памяти (агрессивная)

```bash
# Под упадёт по OOMKilled — это тоже демо!
curl -X POST "http://$INGRESS_IP/chaos/memory-leak?size=400&iterations=2"
kubectl get pods -l app=hackathon-app -w
```

**Наблюдаем на Dashboard:**
- 🧠 Memory Usage (MB) — график резко взлетит до лимита (512 MB)
- Под будет убит Kubernetes'ом по причине `OOMKilled` (Out Of Memory)
- 🔄 Restarts (1h) — счётчик увеличится

### Шаг 7.7: Наблюдаем HPA

Запустите stress-тест снова и наблюдайте автомасштабирование:

```bash
# В одном терминале
k6 run -e BASE_URL=http://$INGRESS_IP load-tests/stress.js

# В другом терминале
kubectl get hpa -w
```

**Наблюдаем на Dashboard:**
- 📈 **HPA Scaling** — линии Desired и Current начнут расти
- Увидите рост от 2 подов до 5-7 подов
- После окончания теста через ~60 секунд поды начнут уменьшаться обратно до 2
- 🟢 **Ready Pods** — количество будет меняться в реальном времени

**Что происходит:**
1. Нагрузка → CPU/Memory растёт → HPA срабатывает
2. Kubernetes создаёт новые поды (от 2 до max 10)
3. Нагрузка прекращается → стабилизация 60 секунд → scale down до 2 подов

## 💡 Полезные команды для демо

### Быстрая проверка всего стека

```bash
# Все URL в одном месте
echo "=========================================="
echo "🌐 DEMO URLs:"
echo "=========================================="
echo "App Health:      http://$INGRESS_IP/health"
echo "App Metrics:     http://$INGRESS_IP/metrics"
echo "Grafana Dashboard: http://$INGRESS_IP/grafana/d/hackathon-dashboard"
echo "Prometheus Alerts: http://$INGRESS_IP/prometheus/alerts"
echo "Alertmanager:    http://$INGRESS_IP/alertmanager"
echo "=========================================="
echo "Login Grafana: admin / (пароль из шага 5.7)"
echo "=========================================="
```

### Быстрый chaos-тест (для демо)

```bash
# Сразу все chaos-режимы (осторожно!)
curl -X POST "http://$INGRESS_IP/chaos/cpu-spike?duration=10000"
curl -X POST "http://$INGRESS_IP/chaos/latency?delay=500"

# Смотрим статус
curl -s http://$INGRESS_IP/chaos/status | jq

# Очищаем всё
curl -X DELETE "http://$INGRESS_IP/chaos/latency"
curl -X DELETE "http://$INGRESS_IP/chaos/memory-leak"
```

### Просмотр логов

```bash
# Логи приложения
kubectl logs -l app=hackathon-app --tail=50 -f

# Логи конкретного пода
kubectl logs <pod-name> --tail=100

# Логи Prometheus
kubectl logs -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 -c prometheus --tail=50
```

### Если что-то пошло не так

```bash
# Перезапустить приложение
kubectl rollout restart deployment hackathon-app

# Перезапустить Prometheus
kubectl rollout restart statefulset -n monitoring prometheus-prometheus-kube-prometheus-prometheus

# Перезапустить Grafana
kubectl rollout restart deployment -n monitoring prometheus-grafana

# Проверить события (ошибки)
kubectl get events --sort-by='.lastTimestamp' | tail -20

# Проверить состояние подов
kubectl get pods -A
```

## 📋 Финальный чеклист

- [ ] VM создана (Ubuntu, SSD)
- [ ] Инструменты установлены (docker, kubectl, helm, yc, k6)
- [ ] Kubernetes кластер работает
- [ ] NAT Gateway настроен
- [ ] Приложение задеплоено (2 пода)
- [ ] Ingress настроен (один LoadBalancer)
- [ ] Prometheus собирает метрики
- [ ] Grafana доступна
- [ ] Dashboard автоматически создан и показывает метрики
- [ ] Telegram алерты приходят
- [ ] Стресс-тест работает (RPS алерты срабатывают)
- [ ] HPA масштабирует поды
- [ ] Chaos-тесты работают (под падает и восстанавливается)

## Хакатон готов! 🎉
