import { runtimeEventSchema } from './types.js';

export const runtimeEventsWebSocketEndpoint = {
  id: 'runtime.events',
  path: '/events',
  serverMessages: runtimeEventSchema,
} as const;
