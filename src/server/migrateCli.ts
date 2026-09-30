import { connectDb, migrate } from './db';

const db = await connectDb();
await migrate(db);
console.log('migrations applied');
await db.close();
