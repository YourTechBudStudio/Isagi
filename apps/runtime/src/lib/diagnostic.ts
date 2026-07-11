export const diagnosticLimit = 512;

export function boundedDiagnostic(value: unknown) {
  return String(value).replaceAll(/\s+/g, ' ').trim().slice(0, diagnosticLimit);
}
