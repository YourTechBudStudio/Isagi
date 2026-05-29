import { implement } from '@orpc/server';

import { contract } from '@isagi/contracts';

import { getRuntimeHealth } from './health.js';

const os = implement(contract);

export const router = os.router({
  health: os.health.handler(() => getRuntimeHealth()),
});
