import { Schema } from 'effect';

export const authLoginInputSchema = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
});

/** How the runtime admitted this request: `none` when login is off. */
export const authSessionOutputSchema = Schema.Struct({
  credential: Schema.Literals(['none', 'token', 'cookie']),
});

/** The username and password did not match; the message never says which. */
export const authLoginFailedErrorSchema = Schema.Struct({
  code: Schema.Literal('auth_login_failed'),
  status: Schema.Literal(401),
  message: Schema.String,
  requestId: Schema.String,
});

export type AuthLoginInput = typeof authLoginInputSchema.Type;
export type AuthSessionOutput = typeof authSessionOutputSchema.Type;
export type AuthLoginFailedError = typeof authLoginFailedErrorSchema.Type;
