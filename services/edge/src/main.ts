import { serve } from '@hono/node-server';
import { z } from 'zod';
import { EDGE } from '@app/contracts';
import { busFromConfig, createLogger, loadConfig, runService } from '@app/service-kit';
import { createFakeEdge, depsFromEnv } from './fake.ts';
import { LocalBus } from './feed.ts';
import { createRealEdge } from './real.ts';
import { sessionKeys } from './session.ts';

if (process.env.EDGE_FAKE === '1') {
  // The fake: the same routes with the fake session check, on the template.
  const fakeEdge = createFakeEdge(await depsFromEnv());
  await runService({ service: 'edge', api: EDGE, fake: () => fakeEdge.handlers, real: () => fakeEdge.handlers, sessionCheck: fakeEdge.sessionCheck });
} else {
  // The real edge builds its own server: it wraps the template in its middleware and serves /live on the same port.
  const cfg = loadConfig('edge', {
    SESSION_PUBLIC_KEYS: z.string({ error: 'set EDGE_SESSION_PUBLIC_KEYS (make dev-secrets writes it)' }).min(1),
    ALLOWED_ORIGINS: z.string().default('https://vultrcontest.vaquerothe.dev'),
    TRUST_PROXY: z.enum(['0', '1']).default('0'),
    HOST: z.string().default('127.0.0.1'),
  });
  const log = createLogger('edge');
  // /live hears every event on Valkey (svc-edge may PSUBSCRIBE events.*) and fans it out to the sockets.
  const valkey = busFromConfig('edge', cfg);
  const feed = new LocalBus();
  const unsubscribe = await valkey.subscribe('all', (event, payload) => feed.deliver(event, payload), (channel) =>
    log.warn({ channel }, 'live: dropped an event that fails its schema'),
  );
  const edge = createRealEdge({
    feed,
    deps: await depsFromEnv(),
    keys: sessionKeys(cfg.SESSION_PUBLIC_KEYS),
    origins: cfg.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: cfg.TRUST_PROXY === '1',
    log,
  });
  const server = serve({ fetch: edge.app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => log.info({ port: info.port, mode: 'real' }, 'listening'));
  const live = edge.attach(server as never);
  const stop = () => {
    live.close();
    void unsubscribe().then(() => valkey.close()).catch(() => {});
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
