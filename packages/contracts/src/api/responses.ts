import { Schema } from 'effect';

export const apiBasePath = '/api/v1';

export const responseMetaSchema = Schema.Struct({
  requestId: Schema.String,
});

export const apiSuccessResponseSchema = <Data extends Schema.Schema.AnyNoContext>(data: Data) =>
  Schema.Struct({
    data,
    meta: responseMetaSchema,
  });

export const apiInfrastructureErrorCodeSchema = Schema.Literal(
  'api_request_decoding_failed',
  'api_request_parsing_failed',
  'api_response_encoding_failed',
  'api_route_not_found',
  'api_unhandled_error',
);

const apiErrorFields = {
  status: Schema.Number.pipe(Schema.int(), Schema.between(100, 599)),
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

export const apiErrorResponseSchema = <Error extends Schema.Schema.AnyNoContext>(error: Error) =>
  Schema.Struct({
    error,
  });

export const apiBaseErrorResponseSchema = apiErrorResponseSchema(apiErrorBaseSchema);

export type ResponseMeta = Schema.Schema.Type<typeof responseMetaSchema>;
export type ApiInfrastructureErrorCode = Schema.Schema.Type<
  typeof apiInfrastructureErrorCodeSchema
>;
export type ApiInfrastructureError = Schema.Schema.Type<typeof apiInfrastructureErrorSchema>;
export type ApiError = Schema.Schema.Type<typeof apiErrorBaseSchema>;
export type ApiErrorResponse = Schema.Schema.Type<typeof apiBaseErrorResponseSchema>;
export type ApiSuccessResponse<Data> = {
  readonly data: Data;
  readonly meta: ResponseMeta;
};
