'use strict';

module.exports = async function verifyMacosPreSign(context) {
  const [{ verifyMacosPreSign: verifyHook }, { verifyRuntimeStageParity }, { stageRoot }] =
    await Promise.all([
      import('./macos-pre-sign.mjs'),
      import('./runtime-stage/parity.mjs'),
      import('./runtime-stage/paths.mjs'),
    ]);
  const parity = verifyHook(context, { sourceRoot: stageRoot, verify: verifyRuntimeStageParity });
  console.log(
    `[desktop] Pre-sign runtime parity passed (${parity.byteFileCount} byte-matched files, ${parity.executableFileCount} executable helpers)`,
  );
};
