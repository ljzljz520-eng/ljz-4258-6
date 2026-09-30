import { buildApp } from './app.js';
import { MemoryStore } from './store.js';
import { PgStore, loadUsersAndDevices } from './pg-store.js';
import { Device, User } from './types.js';

const port = Number(process.env.PORT ?? 8080);
const databaseUrl = process.env.DATABASE_URL;

let store;
let users: User[] = [];
let devices: Device[] = [];
if (databaseUrl) {
  const pg = new PgStore(databaseUrl);
  const seeded = await loadUsersAndDevices(pg.pool);
  store = pg; users = seeded.users; devices = seeded.devices;
} else {
  users = [
    { id: 'u_operator', name: '艾操作员', roles: ['operator'], token: 'demo-operator' },
    { id: 'u_quality', name: '柏质量', roles: ['quality'], token: 'demo-quality' },
    { id: 'u_supervisor', name: '管主管', roles: ['supervisor'], token: 'demo-supervisor' },
  ];
  devices = [
    { id: 'temp-001', name: '1号温度探头', kind: 'temperature', ingestToken: 'ingest-temp-001', active: true },
    { id: 'ph-001', name: '1号pH计', kind: 'ph', ingestToken: 'ingest-ph-001', active: true },
  ];
  store = new MemoryStore(users, devices);
  console.log('DATABASE_URL 未设置：使用内存演示存储，重启数据丢失。生产请先运行 npm run migrate。');
}
const app = await buildApp({ store, users, devices, logger: true, allowedOrigin: process.env.ALLOWED_ORIGIN ?? '*' });
await app.listen({ port, host: '0.0.0.0' });
console.log(`发酵乳记录平台 API: http://localhost:${port}`);
