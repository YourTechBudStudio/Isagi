import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type WorkflowDiscoverySource =
  | {
      readonly kind: 'core';
      readonly rootPath: string;
      readonly explicitlyConfigured: boolean;
    }
  | {
      readonly kind: 'additional';
      readonly rootPath: string;
      readonly configuredIndex: number;
      readonly explicitlyConfigured: boolean;
    }
  | {
      readonly kind: 'project';
      readonly projectId: number | null;
      readonly projectRoot: string;
      readonly rootPath: string;
      readonly explicitlyConfigured: boolean;
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

/** Deduplicates workflow sources whose root paths have already been normalized. */
export function dedupeWorkflowSources(
  sources: readonly WorkflowDiscoverySource[],
): readonly WorkflowDiscoverySource[] {
  const explicitlyConfiguredPaths = new Set(
    sources.filter((source) => source.explicitlyConfigured).map((source) => source.rootPath),
  );
  const seen = new Set<string>();
  const deduped: WorkflowDiscoverySource[] = [];

  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (!source || seen.has(source.rootPath)) continue;
    seen.add(source.rootPath);
    deduped.push({
      ...source,
      explicitlyConfigured: explicitlyConfiguredPaths.has(source.rootPath),
    });
  }

  return deduped.reverse();
}

export function scanWorkflowSource(
  source: WorkflowDiscoverySource,
): readonly WorkflowFilesystemCandidate[] {
  const names = readdirSync(source.rootPath);

  return names
    .filter((name) => !name.startsWith('.') && name !== 'node_modules')
    .sort((left, right) => left.localeCompare(right))
    .map((workflowKey) => ({
      workflowKey,
      packageRoot: join(source.rootPath, workflowKey),
      source,
    }));
}
