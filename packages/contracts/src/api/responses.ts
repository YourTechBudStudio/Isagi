import { Schema } from 'effect';

export const apiBasePath = '/api/v1';

export const responseMetaSchema = Schema.Struct({
  requestId: Schema.String,
});

export const apiSuccessResponseSchema = <Data extends Schema.Codec<unknown>>(data: Data) =>
  Schema.Struct({
    data,
    meta: responseMetaSchema,
  });

export const apiInfrastructureErrorCodeSchema = Schema.Literals([
  'api_host_not_allowed', // refused by the runtime's Host guard
  'api_request_decoding_failed',
  'api_request_parsing_failed',
  'api_response_encoding_failed',
  'api_route_not_found',
  'api_unhandled_error',
]);

const apiErrorFields = {
  status: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 })),
  message: Schema.String,
  requestId: Schema.String,
  data: Schema.optional(Schema.Unknown),
} as const;

export const apiErrorBaseSchema = Schema.Struct({
  code: Schema.String,
  ...apiErrorFields,
});

export const apiInfrastructureErrorSchema = Schema.Struct({
  code: apiInfrastructureErrorCodeSchema,
  ...apiErrorFields,
});

export const apiErrorResponseSchema = <Error extends Schema.Codec<unknown>>(error: Error) =>
  Schema.Struct({
    error,
  });

export const apiBaseErrorResponseSchema = apiErrorResponseSchema(apiErrorBaseSchema);

export type ResponseMeta = typeof responseMetaSchema.Type;
export type ApiInfrastructureErrorCode = typeof apiInfrastructureErrorCodeSchema.Type;
export type ApiInfrastructureError = typeof apiInfrastructureErrorSchema.Type;
export type ApiError = typeof apiErrorBaseSchema.Type;
export type ApiErrorResponse = typeof apiBaseErrorResponseSchema.Type;
export type ApiSuccessResponse<Data> = {
  readonly data: Data;
  readonly meta: ResponseMeta;
};
