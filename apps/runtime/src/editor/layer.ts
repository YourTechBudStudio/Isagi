import { Layer } from 'effect';

import { EditorContextService } from './contexts/service.js';
import { EditorProvisioning } from './provisioning/service.js';

/** The editor module's public services. Each service's `layer` wires its own module dependencies. */
export const EditorLayer = Layer.mergeAll(EditorContextService.layer, EditorProvisioning.layer);
