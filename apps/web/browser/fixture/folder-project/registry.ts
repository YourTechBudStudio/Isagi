import { createFixtureRegistry } from '../test-support/registry.js';

/** This page's app session, shared by the app and its fake runtime (the fake runtime re-reads the workspace through it too). */
export const fixtureRegistry = createFixtureRegistry();
