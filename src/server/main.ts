import Fastify from 'fastify';
import cors from '@fastify/cors';
import { connectDb, createTestDb, migrate, type Db } from './db';
import { AppServices, HttpError } from './services';

export async function createApp(input?: { db?: Db; logger?: boolean }) {
  const db = input?.db ?? (process.env.NODE_ENV === 'test' ? await createTestDb() : await connectDb());
  if (process.env.NODE_ENV === 'test') await migrate(db);
  const services = new AppServices(db);
  const app = Fastify({ logger: input?.logger ?? false });
  await app.register(cors, { origin: true, credentials: true });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error;
    if (error instanceof HttpError) {
      reply.status(error.status).send({ error: error.reason, message: error.message, details: error.payload });
    } else {
      req.log.error(error);
      reply.status(500).send({ error: 'INTERNAL', message: err.message });
    }
  });

  async function auth(req: any) {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    return services.authenticate(token);
  }

  app.post('/auth/login', async (req: any) => {
    const { login, password } = req.body ?? {};
    return services.login(String(login ?? ''), String(password ?? ''));
  });

  app.get('/auth/me', async (req) => ({ user: await auth(req) }));

  app.get('/strains', async () => ({ items: await services.listStrains() }));
  app.post('/strains', async (req: any) => ({ item: await services.createStrain(await auth(req), req.body ?? {}) }));
  app.post('/strains/:id/transition', async (req: any) => ({ item: await services.transitionStrain(await auth(req), req.params.id, String(req.body?.state)) }));

  app.get('/milk-bases', async () => ({ items: await services.listMilkBases() }));
  app.post('/milk-bases', async (req: any) => ({ item: await services.createMilkBase(await auth(req), req.body ?? {}) }));
  app.post('/milk-bases/:id/transition', async (req: any) => ({ item: await services.transitionMilk(await auth(req), req.params.id, String(req.body?.state)) }));

  app.get('/sources', async () => ({ items: await services.listSources() }));
  app.post('/sources/:id/calibrations', async (req: any) => ({ item: await services.addCalibration(await auth(req), req.params.id, req.body ?? {}) }));

  app.get('/batches', async () => ({ items: await services.listBatches() }));
  app.post('/batches', async (req: any) => ({ ...(await services.createBatch(await auth(req), req.body ?? {})) }));
  app.get('/batches/:id', async (req: any) => services.getBatch(req.params.id));
  app.patch('/batches/:id', async (req: any) => services.updateBatch(await auth(req), req.params.id, req.body ?? {}));
  app.post('/batches/:id/commands', async (req: any) => services.command(await auth(req), req.params.id, String(req.body?.command) as any, req.body?.expected_version));
  app.post('/batches/:id/inoculation/confirm', async (req: any) => services.confirmInoculation(await auth(req), req.params.id, req.body ?? {}));
  app.post('/batches/:id/readings', async (req: any) => services.ingestReading({ batch_id: req.params.id, ...req.body }, await auth(req)));

  app.post('/sync', async (req: any) => services.sync(await auth(req), req.body ?? {}));

  app.get('/coordination', async (req: any) => ({ items: await services.listCoordination(String(req.query?.status ?? 'open')) }));
  app.post('/coordination/:id/resolve', async (req: any) => ({ item: await services.resolveCoordination(await auth(req), Number(req.params.id), String(req.body?.decision ?? 'resolved') as any, String(req.body?.note ?? '')) }));

  app.get('/health', async () => ({ ok: true, time: new Date().toISOString() }));
  return { app, db, services };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  const { app } = await createApp();
  await app.listen({ host: '0.0.0.0', port });
}
