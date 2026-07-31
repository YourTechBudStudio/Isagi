import { resolve } from 'node:path';

export function verifyMacosPreSign(context, { sourceRoot, verify }) {
  if (context.electronPlatformName !== 'darwin') {
    throw new Error('The macOS pre-sign parity hook was invoked for a non-macOS package.');
  }
  const packagedRuntime = resolve(context.appOutDir, 'Isagi.app/Contents/Resources/runtime');
  return verify(sourceRoot, packagedRuntime, 'darwin');
}
