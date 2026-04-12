import postgres from 'postgres';
import { logger } from '../services/logger';

let sql: postgres.Sql;

export async function connectDB(): Promise<void> {
  sql = postgres(process.env.DATABASE_URL ?? 'postgresql://localhost:5432/remex', {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: (msg) => logger.debug(msg),
  });

  // Test connection
  await sql`SELECT 1`;
}

export function getDB(): postgres.Sql {
  if (!sql) throw new Error('Database not connected. Call connectDB() first.');
  return sql;
}