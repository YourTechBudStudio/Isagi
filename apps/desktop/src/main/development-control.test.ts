import assert from 'node:assert/strict';
import test from 'node:test';

import { isRuntimeStageReadyControl } from './development-control.js';

test('development control accepts only the versioned runtime-stage readiness record', () => {
  assert.equal(isRuntimeStageReadyControl('ordinary input'), false);
  assert.equal(
    isRuntimeStageReadyControl('ISAGI_DEV_CONTROL {"protocolVersion":1,"runtimeStage":"ready"}'),
    true,
  );
  assert.throws(
    () =>
      isRuntimeStageReadyControl('ISAGI_DEV_CONTROL {"protocolVersion":2,"runtimeStage":"ready"}'),
    /Unsupported development control record/,
  );
  assert.throws(() => isRuntimeStageReadyControl('ISAGI_DEV_CONTROL nope'), SyntaxError);
});
