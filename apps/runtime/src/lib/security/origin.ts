import process from 'node:process';

import type { FastifyReply, FastifyRequest } from 'fastify';

export function isAllowedRuntimeOrigin(origin: string | undefined) {
  // Local non-browser clients commonly omit Origin, and opaque origins use null.
  // This is a deliberate local-client trust allowance, not browser authentication.
  // The packaged desktop's concrete file:// origin is configured explicitly.
  if (!origin || origin === 'null') {
    return true;
  }

  return allowedRuntimeOrigins().has(origin);
}

export function enforceRuntimeWebSocketOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
) {
  const header = request.headers.origin;
  const origin = Array.isArray(header) ? header[0] : header;
  if (!isAllowedRuntimeOrigin(origin)) {
    reply.code(403).send('Forbidden');
    return;
  }
  done();
}

function allowedRuntimeOrigins() {
  const configured = process.env.ISAGI_ALLOWED_ORIGINS?.split(',') ?? [];
  return new Set(configured.map((origin) => origin.trim()).filter(Boolean));
}
