import { createRoot } from 'react-dom/client';

import '../../fixture.css';
import { installFakeRuntime } from './fake-runtime.js';
import { FluidcastTestSupportApp } from './FluidcastTestSupportApp.js';

// Before React, because the surface-detail query fires on its first render and has to find a
// runtime already answering. Not `StrictMode`, like the other harnesses; the presentation diff's
// StrictMode behavior is covered by its unit tests.
const runtime = await installFakeRuntime();

createRoot(document.getElementById('root')!).render(<FluidcastTestSupportApp runtime={runtime} />);
