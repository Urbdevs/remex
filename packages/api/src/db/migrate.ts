import { readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';
import { config } from 'dotenv';

config();

async function migrate() {
  const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://localhost:5432/remex');

  console.log('Running migrations...');
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await sql.unsafe(schema);
  console.log('Migrations complete.');

  await sql.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});