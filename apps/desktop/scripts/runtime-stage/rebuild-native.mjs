import { rebuild } from '@electron/rebuild';

const options = JSON.parse(process.argv[2] ?? 'null');
if (!options) throw new Error('Expected serialized Electron rebuild options.');

await rebuild({
  ...options,
  force: true,
  mode: 'sequential',
  useCache: false,
});
