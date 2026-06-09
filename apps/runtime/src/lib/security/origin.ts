import process from 'node:process';

export function isAllowedRuntimeOrigin(origin: string | undefined) {
  if (!origin || origin === 'null') {
    return true;
  }

  return allowedRuntimeOrigins().has(origin);
}

function allowedRuntimeOrigins() {
  const configured = process.env.ISAGI_ALLOWED_ORIGINS?.split(',') ?? [];
  return new Set(
    ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://[::1]:5173', ...configured]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}
