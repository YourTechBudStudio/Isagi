export { registerApiEndpoint } from './endpoint.js';
export type { RegisterApiEndpointOptions } from './endpoint.js';
export { registerContentEndpoint } from './content-endpoint.js';
export type { ContentResponse, RegisterContentEndpointOptions } from './content-endpoint.js';
export {
  errorMessage,
  requestDecodingFailed,
  responseEncodingFailed,
  sendApiError,
  unhandledApiError,
} from './errors.js';
export type { ApiRouteContext } from './errors.js';
export { infrastructureApiError } from './infrastructure-errors.js';
