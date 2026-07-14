import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type WorkflowDiscoverySource =
  | {
      readonly kind: 'global';
      readonly rootPath: string;
    }
  | {
      readonly kind: 'project';
      readonly projectId: number | null;
      readonly projectRoot: string;
      readonly rootPath: string;
    };

export interface WorkflowFilesystemCandidate {
  readonly workflowKey: string;
  readonly packageRoot: string;
  readonly source: WorkflowDiscoverySource;
}

export interface DiscoveredFilesystemWorkflow {
  readonly workflowKey: string;
  readonly winner: WorkflowFilesystemCandidate;
  readonly shadowed: readonly WorkflowFilesystemCandidate[];
}

export type ScanWorkflowSource = (
  source: WorkflowDiscoverySource,
) => readonly WorkflowFilesystemCandidate[];

export function discoverOrderedWorkflowSources(
  sources: readonly WorkflowDiscoverySource[],
  scanSource: ScanWorkflowSource = scanWorkflowSource,
): readonly DiscoveredFilesystemWorkflow[] {
  const discovered = new Map<string, DiscoveredFilesystemWorkflow>();

  for (const source of sources) {
    for (const candidate of scanSource(source)) {
      const existing = discovered.get(candidate.workflowKey);
      discovered.set(candidate.workflowKey, {
        workflowKey: candidate.workflowKey,
        winner: candidate,
        shadowed: existing ? [...existing.shadowed, existing.winner] : [],
      });
    }
  }

  return [...discovered.values()].sort((left, right) =>
    left.workflowKey.localeCompare(right.workflowKey),
  );
}

export function scanWorkflowSource(
  source: WorkflowDiscoverySource,
): readonly WorkflowFilesystemCandidate[] {
  let names: readonly string[];
  try {
    names = readdirSync(source.rootPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }

  return names
    .filter((name) => !name.startsWith('.') && name !== 'node_modules')
    .sort((left, right) => left.localeCompare(right))
    .map((workflowKey) => ({
      workflowKey,
      packageRoot: join(source.rootPath, workflowKey),
      source,
    }));
}
