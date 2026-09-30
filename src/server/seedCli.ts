import { connectDb } from './db';
import { seedDemo } from './seed';

const db = await connectDb();
const result = await seedDemo(db);
console.log(JSON.stringify(result, null, 2));
await db.close();
