export interface GitWorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly prunable: boolean;
}

export function parseGitWorktreeListPorcelain(output: string): GitWorktreeRecord[] {
  return output
    .split(/\n\s*\n/g)
    .map((record) => parseRecord(record.trim()))
    .filter((record): record is GitWorktreeRecord => record !== null);
}

export function displayBranch(ref: string | null, _head: string | null): string | null {
  if (ref?.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  if (ref) {
    return ref;
  }
  return null;
}

function parseRecord(record: string): GitWorktreeRecord | null {
  if (!record) {
    return null;
  }

  let path: string | null = null;
  let head: string | null = null;
  let branch: string | null = null;
  let bare = false;
  let prunable = false;

  for (const line of record.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      branch = displayBranch(line.slice('branch '.length), head);
    } else if (line === 'bare') {
      bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      prunable = true;
    }
  }

  if (!path) {
    return null;
  }

  return { path, head, branch: branch ?? displayBranch(null, head), bare, prunable };
}
