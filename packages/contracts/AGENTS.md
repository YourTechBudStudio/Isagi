# Contracts

- Contracts are implementation-free schemas: no Effect errors, services, layers or effects, no domain implementation errors and no runtime or operational concepts.
- A `Schema.Unknown` property that can be absent is `Schema.optionalKey(Schema.Unknown)`: v4 rejects a missing key.
- Runtime routes use the `/api/v1` prefix. Success is `{ data, meta: { requestId } }`; errors are `{ error: { code, status, message, requestId, data? } }`.
- JSON field names are `camelCase`, including protocol metadata and error data. String literal values (error codes, reasons, enum-like literals) are `snake_case`.
- An error code identifies the subsystem and operation; nuanced causes go in structured fields such as `data.reason` instead of more code variants.
