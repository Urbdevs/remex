import { FastifyInstance } from 'fastify';
import { getDB } from '../db/client';

export async function healthRoutes(server: FastifyInstance) {
  server.get('/', async (request, reply) => {
    try {
      const db = getDB();
      await db`SELECT 1`;
      return reply.send({
        status:    'ok',
        timestamp: new Date().toISOString(),
        services: {
          database: 'ok',
          server:   'ok',
        },
      });
    } catch (err) {
      return reply.status(503).send({
        status:  'error',
        message: 'Database unavailable',
      });
    }
  });
}