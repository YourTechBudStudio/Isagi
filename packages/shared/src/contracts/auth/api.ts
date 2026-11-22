import { Schema } from 'effect';

import { apiInfrastructureErrorSchema } from '../api/responses.js';
import type { ApiEndpoint, WireSchema } from '../api/types.js';
import {
  authLoginFailedErrorSchema,
  authLoginInputSchema,
  authSessionOutputSchema,
} from './types.js';

export const authLoginApiErrorSchema = Schema.Union([
  authLoginFailedErrorSchema,
  apiInfrastructureErrorSchema,
]);

/**
 * Optional runtime login (`server.auth`). `login` is the one public route; `login` and `logout` exist only while
 * login is on, and `session` always answers.
 */
export const authEndpoints = {
  /** Checks a username and password and sets the `isagi_session` cookie. */
  login: {
    id: 'auth.login',
    method: 'POST',
    path: '/auth/login',
    body: authLoginInputSchema,
    output: Schema.Null,
    errors: authLoginApiErrorSchema,
  },
  /** Clears this browser's `isagi_session` cookie. */
  logout: {
    id: 'auth.logout',
    method: 'POST',
    path: '/auth/logout',
    output: Schema.Null,
    errors: apiInfrastructureErrorSchema,
  },
  /** How this request was admitted. */
  session: {
    id: 'auth.session',
    method: 'GET',
    path: '/auth/session',
    output: authSessionOutputSchema,
    errors: apiInfrastructureErrorSchema,
  },
} as const satisfies Record<string, ApiEndpoint<WireSchema, WireSchema, WireSchema, WireSchema>>;
