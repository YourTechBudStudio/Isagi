import { runtimeEventInputMessageSchema, runtimeEventSchema } from './types.js';

export const runtimeEventsWebSocketEndpoint = {
  id: 'runtime.events',
  path: '/events',
  clientMessages: runtimeEventInputMessageSchema,
  serverMessages: runtimeEventSchema,
} as const;
