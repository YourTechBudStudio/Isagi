import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Schema } from 'effect';

import {
  durableSessionIdentitySchema,
  editorApiErrorSchema,
  editorContextFactsSchema,
  editorContextMetadataSchema,
  editorEndpoints,
  editorProvisioningStateSchema,
  paneSessionClaimInputSchema,
  paneSessionCreateInputSchema,
  paneSessionKindSchema,
  paneSessionSpecSchema,
  surfacePaneSessionSchema,
  type EditorContextFacts,
} from '@isagi/contracts';

/**
 * The pane model asks two different questions, and this file exists to stop them
 * being collapsed back into one literal. `paneSessionKindSchema` answers "what is
 * in this pane" and includes editors; the creation, claim, and durable-session
 * vocabularies answer "what may be minted, claimed, or attached to" and do not.
 * Neither asymmetry has a compile-time guard, so both are asserted here.
 */

const facts: EditorContextFacts = {
  id: 4,
  worktreeId: 1,
  activePtyProcessId: null,
  attempt: { state: 'none' },
  processStatus: null,
  processDiagnostic: null,
  processDiagnosticDetail: null,
  workbenchReadiness: null,
  readinessDetail: null,
  endpoint: null,
  hasDiagnostics: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('pane-content vocabulary', () => {
  it('accepts an editor as projected pane content', () => {
    assert.deepEqual(paneSessionKindSchema.literals, [
      'agent_session',
      'terminal_session',
      'editor_context',
    ]);
    const decoded = Schema.decodeUnknownSync(surfacePaneSessionSchema)({
      kind: 'editor_context',
      editorContext: { paneId: 9, ...facts },
    });
    assert.equal(decoded.kind, 'editor_context');
  });
});

describe('an editor context is not generically creatable or claimable', () => {
  // Editors are minted by the editor domain under its own per-worktree lock. If
  // any of these widened, a generic create, split, or claim could bring one into
  // existence outside that lock.
  it('paneSessionSpecSchema rejects editor_context', () => {
    assert.equal(Schema.is(paneSessionSpecSchema)({ kind: 'editor_context' }), false);
  });

  it('paneSessionCreateInputSchema rejects editor_context', () => {
    assert.equal(
      Schema.is(paneSessionCreateInputSchema)({ kind: 'editor_context', paneId: 1 }),
      false,
    );
  });

  it('paneSessionClaimInputSchema has no editor action', () => {
    assert.equal(
      Schema.is(paneSessionClaimInputSchema)({
        action: 'claim_editor_context',
        paneId: 1,
        editorContextId: 1,
      }),
      false,
    );
  });
});

describe('the durable PTY-session vocabulary stays two-kind', () => {
  // This identity backs `durable_session_deleted` and the web's terminal cache.
  // An editor owns no attachment for either to service.
  it('durableSessionIdentitySchema rejects editor_context', () => {
    assert.equal(
      Schema.is(durableSessionIdentitySchema)({
        kind: 'editor_context',
        sessionId: 1,
        worktreeId: 1,
      }),
      false,
    );
  });

  it('durableSessionIdentitySchema still accepts both PTY kinds', () => {
    for (const kind of ['agent_session', 'terminal_session'] as const) {
      assert.equal(
        Schema.is(durableSessionIdentitySchema)({ kind, sessionId: 1, worktreeId: 1 }),
        true,
      );
    }
  });
});

describe('editor DTOs round-trip', () => {
  it('encodes and decodes context facts without a placement', () => {
    const encoded = Schema.encodeSync(editorContextFactsSchema)(facts);
    assert.deepEqual(Schema.decodeUnknownSync(editorContextFactsSchema)(encoded), facts);
    // Placement is a surfaces fact, so it is absent from the editor's own answer.
    assert.equal('paneId' in encoded, false);
  });

  it('requires a placement on the pane-bound projection', () => {
    assert.equal(Schema.is(editorContextMetadataSchema)(facts), false);
    assert.equal(Schema.is(editorContextMetadataSchema)({ paneId: 9, ...facts }), true);
  });

  it('carries a settled endpoint and readiness once an incarnation exists', () => {
    const live = Schema.decodeUnknownSync(editorContextFactsSchema)({
      ...facts,
      activePtyProcessId: 12,
      processStatus: 'running',
      workbenchReadiness: 'ready',
      endpoint: { host: '127.0.0.1', port: 41_234, url: 'http://127.0.0.1:41234/' },
      hasDiagnostics: true,
    });
    assert.equal(live.endpoint?.url, 'http://127.0.0.1:41234/');
    assert.equal(live.workbenchReadiness, 'ready');
  });

  it('rejects a port outside the addressable range', () => {
    assert.equal(
      Schema.is(editorContextFactsSchema)({
        ...facts,
        endpoint: { host: '127.0.0.1', port: 70_000, url: 'http://127.0.0.1:70000/' },
      }),
      false,
    );
  });

  it('models provisioning as settled or versioned-transient', () => {
    assert.equal(Schema.is(editorProvisioningStateSchema)({ status: 'not_applicable' }), true);
    assert.equal(
      Schema.is(editorProvisioningStateSchema)({ status: 'downloading', version: '4.135.0' }),
      true,
    );
    // A transient state without the version it is working towards is not a state
    // the startup gate could report on.
    assert.equal(Schema.is(editorProvisioningStateSchema)({ status: 'downloading' }), false);
  });
});

describe('the editor error union covers every branch its mapper can emit', () => {
  // The route helper validates any error whose code does not begin with `api_`
  // against the endpoint's schema; a miss reaches the client as an encoding
  // failure instead of the real fault.
  const requestId = 'req-1';
  const cases = [
    {
      code: 'editor_rejected',
      status: 400,
      message: 'no',
      requestId,
      data: { reason: 'editor_unavailable' },
    },
    {
      code: 'editor_launch_failed',
      status: 409,
      message: 'no',
      requestId,
      data: { reason: 'port_allocation_failed', editorContextId: 4 },
    },
    {
      code: 'editor_diagnostics_unavailable',
      status: 500,
      message: 'no',
      requestId,
      data: { detail: 'unreadable' },
    },
    {
      code: 'surface_rejected',
      status: 400,
      message: 'no',
      requestId,
      data: { reason: 'worktree_not_found' },
    },
    {
      code: 'runtime_database_failed',
      status: 500,
      message: 'no',
      requestId,
      data: { operation: 'openEditor' },
    },
  ];

  for (const error of cases) {
    it(`encodes ${error.code}`, () => {
      assert.equal(Schema.is(editorApiErrorSchema)(error), true);
    });
  }

  it('every editor endpoint carries that same union', () => {
    for (const endpoint of Object.values(editorEndpoints)) {
      assert.equal(endpoint.errors, editorApiErrorSchema);
    }
  });
});
