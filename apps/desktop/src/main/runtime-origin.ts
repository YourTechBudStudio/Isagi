type ManagedRuntimeOriginConfiguration =
  | { mode: 'packaged' }
  | {
      mode: 'development';
      webOrigin: string;
      configuredAllowedOrigins: string | undefined;
    };

const packagedRendererOrigin = 'file://';

export function managedRuntimeAllowedOrigins(configuration: ManagedRuntimeOriginConfiguration) {
  if (configuration.mode === 'packaged') {
    return packagedRendererOrigin;
  }

  const configured = configuration.configuredAllowedOrigins?.split(',') ?? [];
  return [
    ...new Set([
      configuration.webOrigin,
      ...configured.map((origin) => origin.trim()).filter(Boolean),
    ]),
  ].join(',');
}
