import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CommandPort } from '@isagi/contracts';

import {
  commandBadgeId,
  commandEndpointsPresentation,
  commandPortsSignature,
  commandStripEndpoints,
  isPathlessCommandPort,
  pathlessCommandPortNumbers,
} from './command-ports.js';

function port(
  value: number,
  paths: readonly (readonly [string, string])[] = [],
  envVar: string | null = null,
): CommandPort {
  return {
    port: value,
    envVar,
    urls: paths.map(([label, path]) => ({
      label,
      path,
      url: `http://localhost:${value}${path}`,
    })),
  };
}

const WEB = port(5173, [['app', '/']]);
const API = port(
  51824,
  [
    ['docs', '/docs'],
    ['health', '/healthz'],
  ],
  'API_PORT',
);
const INSPECTOR = port(9229);

describe('isPathlessCommandPort', () => {
  it('is the one definition of "nothing to open"', () => {
    assert.equal(isPathlessCommandPort(INSPECTOR), true);
    assert.equal(isPathlessCommandPort(WEB), false);
  });
});

describe('commandEndpointsPresentation', () => {
  it('renders no toggle at all for an authoritative empty array', () => {
    // `[]` means this incarnation declared no ports. There is nothing to say, so
    // the header keeps exactly the shape it has for every other command.
    assert.equal(commandEndpointsPresentation([], 'local'), null);
    assert.equal(commandEndpointsPresentation([], 'non_local'), null);
  });

  it('keeps degraded metadata visible rather than collapsing it into silence', () => {
    for (const locality of ['local', 'non_local'] as const) {
      const view = commandEndpointsPresentation(null, locality);
      assert.ok(view);
      assert.deepEqual(view.summary, { kind: 'unknown' });
      // Amber, because the strip shows nothing in this state and the drawer is
      // the only channel left.
      assert.equal(view.tone, 'attention');
      assert.equal(view.copyable, false);
      assert.equal(view.withheld, false);
    }
  });

  it('counts URLs and offers copying when the runtime is local', () => {
    const view = commandEndpointsPresentation([API, INSPECTOR], 'local');
    assert.ok(view);
    assert.deepEqual(view.summary, { kind: 'urls', count: 2 });
    assert.equal(view.copyable, true);
    assert.equal(view.withheld, false);
    assert.equal(view.tone, 'quiet');
  });

  it('withholds URLs but keeps the port facts when the runtime is not local', () => {
    const view = commandEndpointsPresentation([API, INSPECTOR], 'non_local');
    assert.ok(view);
    // Counts ports, not URLs: counting things the panel cannot offer would be a
    // promise it does not keep.
    assert.deepEqual(view.summary, { kind: 'ports_without_urls', count: 2 });
    assert.equal(view.copyable, false);
    assert.equal(view.withheld, true);
    assert.equal(view.tone, 'attention');
  });

  it('stays quiet for an all-pathless set under both localities', () => {
    // Nothing is being withheld here, because there were never any URLs to
    // withhold. Going amber would claim a loss the user has not suffered.
    for (const locality of ['local', 'non_local'] as const) {
      const view = commandEndpointsPresentation([INSPECTOR, port(5432)], locality);
      assert.ok(view);
      assert.deepEqual(view.summary, { kind: 'ports', count: 2 });
      assert.equal(view.withheld, false);
      assert.equal(view.tone, 'quiet');
      assert.equal(view.copyable, false);
    }
  });

  it('speaks singular for a single url and a single port', () => {
    const single = commandEndpointsPresentation([WEB], 'local');
    assert.deepEqual(single?.summary, { kind: 'urls', count: 1 });
    const pathless = commandEndpointsPresentation([INSPECTOR], 'local');
    assert.deepEqual(pathless?.summary, { kind: 'ports', count: 1 });
  });
});

describe('commandStripEndpoints', () => {
  it('emits one badge per URL and one raw token per pathless port, in declaration order', () => {
    assert.deepEqual(commandStripEndpoints([API, INSPECTOR], 'local'), [
      { kind: 'url', port: 51824, label: 'docs', url: 'http://localhost:51824/docs' },
      { kind: 'url', port: 51824, label: 'health', url: 'http://localhost:51824/healthz' },
      { kind: 'port', port: 9229 },
    ]);
  });

  it('never reinterprets a withheld port as a pathless one', () => {
    // The non-local strip drops the URL badges, but a port that *has* paths must
    // not fall back to a raw token: that would present a withheld endpoint as one
    // that never had a URL, which is a different and untrue fact.
    assert.deepEqual(commandStripEndpoints([API, INSPECTOR], 'non_local'), [
      { kind: 'port', port: 9229 },
    ]);
  });

  it('shows nothing for degraded metadata', () => {
    assert.deepEqual(commandStripEndpoints(null, 'local'), []);
    assert.deepEqual(commandStripEndpoints([], 'local'), []);
  });
});

describe('pathlessCommandPortNumbers', () => {
  it('offers the palette only ports that have no other representation', () => {
    // A port with paths already appears as a strip badge and a drawer row.
    assert.deepEqual(pathlessCommandPortNumbers([API, INSPECTOR]), [9229]);
    assert.deepEqual(pathlessCommandPortNumbers([WEB]), []);
    assert.deepEqual(pathlessCommandPortNumbers(null), []);
    assert.deepEqual(pathlessCommandPortNumbers([]), []);
  });
});

describe('commandBadgeId', () => {
  it('keeps tuples distinct when their parts contain the separator', () => {
    // Command names and URL labels are free-form config strings — only
    // surrounding whitespace is rejected — so a delimiter join is not injective.
    // These two are both valid configuration and both join to `a:5001:5002:x`.
    assert.notEqual(
      commandBadgeId('configured', 'a:5001', 5002, 'x'),
      commandBadgeId('configured', 'a', 5001, '5002:x'),
    );
  });

  it('keeps a number distinct from its digit string', () => {
    assert.notEqual(commandBadgeId(5173, 'app'), commandBadgeId('5173', 'app'));
  });

  it('is stable for the same tuple, so a badge keeps its identity across renders', () => {
    assert.equal(
      commandBadgeId('configured', 'api', 51_824, 'docs'),
      commandBadgeId('configured', 'api', 51_824, 'docs'),
    );
  });
});

describe('commandPortsSignature', () => {
  it('separates unknown from empty and notices a changed resolution', () => {
    assert.equal(commandPortsSignature(null), 'unknown');
    assert.notEqual(commandPortsSignature([]), commandPortsSignature(null));
    assert.notEqual(
      commandPortsSignature([WEB]),
      commandPortsSignature([port(5174, [['app', '/']])]),
    );
    assert.equal(commandPortsSignature([API]), commandPortsSignature([API]));
  });

  it('notices a path change that keeps the same port', () => {
    assert.notEqual(
      commandPortsSignature([WEB]),
      commandPortsSignature([port(5173, [['app', '/ui']])]),
    );
  });
});
