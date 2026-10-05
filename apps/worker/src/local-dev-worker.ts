import { createServer } from 'node:http';
import net from 'node:net';

interface ServiceHealth {
  ok: boolean;
  reason?: string;
}

interface RuntimeHealth {
  redis: ServiceHealth;
  postgres: ServiceHealth;
  checkedAt: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRedisEndpoint(redisUrl: string): { host: string; port: number } {
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname || 'redis',
    port: parsePort(parsed.port, 6379),
  };
}

function parsePostgresEndpoint(databaseUrl: string): { host: string; port: number } {
  const parsed = new URL(databaseUrl);
  return {
    host: parsed.hostname || 'postgres',
    port: parsePort(parsed.port, 5432),
  };
}

async function probeTcp(host: string, port: number, timeoutMs = 3_000): Promise<ServiceHealth> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (health: ServiceHealth): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(health);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: `timeout (${timeoutMs}ms)` }));
    socket.once('error', (error) => finish({ ok: false, reason: error.message }));
    socket.connect(port, host);
  });
}

const redisUrl = process.env['REDIS_URL'] ?? 'redis://redis:6379';
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgresql://postgres:5432/wptossg';
const healthPort = parsePort(process.env['WORKER_HEALTH_PORT'], 4001);

const redisEndpoint = parseRedisEndpoint(redisUrl);
const postgresEndpoint = parsePostgresEndpoint(databaseUrl);

let healthState: RuntimeHealth = {
  redis: { ok: false, reason: 'not checked yet' },
  postgres: { ok: false, reason: 'not checked yet' },
  checkedAt: new Date(0).toISOString(),
};

async function refreshHealth(): Promise<void> {
  const [redis, postgres] = await Promise.all([
    probeTcp(redisEndpoint.host, redisEndpoint.port),
    probeTcp(postgresEndpoint.host, postgresEndpoint.port),
  ]);

  healthState = {
    redis,
    postgres,
    checkedAt: new Date().toISOString(),
  };

  console.log(
    JSON.stringify({
      level: redis.ok && postgres.ok ? 'info' : 'warn',
      message: 'local worker dependency check',
      checkedAt: healthState.checkedAt,
      redis: { endpoint: redisEndpoint, ...redis },
      postgres: { endpoint: postgresEndpoint, ...postgres },
    }),
  );
}

await refreshHealth();
setInterval(() => {
  void refreshHealth();
}, 10_000).unref();

const server = createServer((request, response) => {
  if (!request.url?.startsWith('/healthz')) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }

  const ok = healthState.redis.ok && healthState.postgres.ok;
  response.statusCode = ok ? 200 : 503;
  response.setHeader('Content-Type', 'application/json');
  response.end(
    JSON.stringify({
      status: ok ? 'ok' : 'degraded',
      checkedAt: healthState.checkedAt,
      dependencies: {
        redis: healthState.redis,
        postgres: healthState.postgres,
      },
    }),
  );
});

server.listen(healthPort, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'local worker started',
      healthPort,
      redisEndpoint,
      postgresEndpoint,
      googleDriveEnabled: process.env['GOOGLE_DRIVE_ENABLED'] ?? 'false',
    }),
  );
});
