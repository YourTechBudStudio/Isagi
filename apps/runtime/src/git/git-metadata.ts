import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Corroboration for a *negative* Git answer, and nothing more.
 *
 * Git's "not a git repository" is not evidence that no Git data exists — it is
 * the same answer git gives for Git data it refuses to load. An empty `.git`, a
 * broken `HEAD`, a dangling `.git` symlink, or a stripped bare directory all
 * produce it, byte for byte. Because a project's kind is immutable once stored,
 * recording any of those as a plain folder would be unrecoverable. So after git
 * has already refused, this asks the one remaining question: was there
 * git-shaped data here for git to have refused?
 *
 * It never decides that something *is* a repository, so it can only turn a
 * folder verdict into a refusal, never a refusal into an acceptance.
 */
export type GitMetadataOnPath =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly path: string }
  | { readonly kind: 'indeterminate'; readonly path: string };

/**
 * The entries git's own git-directory check requires. A bare repository is one
 * of these directories, with no `.git` child to mark it.
 */
const GIT_DIRECTORY_ENTRIES = ['HEAD', 'objects', 'refs'] as const;

/**
 * Two of the three, not all three: deleting any single one of them leaves a
 * directory git refuses but that is still plainly git's. Not one of the three
 * either — a lone `objects/` or `refs/` is an ordinary directory name, and
 * refusing on it would block real folders.
 */
const GIT_DIRECTORY_MATCH_THRESHOLD = 2;

type EntryPresence = 'present' | 'absent' | 'indeterminate';

/**
 * The only filesystem call this module makes. Narrowed to the one fact the walk
 * needs — did the entry exist — so tests can drive traversal and errno handling
 * together without mocking `node:fs` globally, which the runtime's shared-process
 * test runner would leak into every other suite.
 */
export type LstatEntry = (path: string) => void;

const realLstat: LstatEntry = (path) => {
  lstatSync(path);
};

export function gitMetadataOnPath(
  rootPath: string,
  lstat: LstatEntry = realLstat,
): GitMetadataOnPath {
  let directory = rootPath;
  for (;;) {
    const dotGitPath = join(directory, '.git');
    const dotGit = entryPresence(dotGitPath, lstat);
    if (dotGit !== 'absent') {
      return { kind: dotGit, path: dotGitPath };
    }

    // A bare git directory carries no marker; its metadata *is* the directory,
    // so recognizing a damaged one is unavoidably a question of how much remains.
    const signature = GIT_DIRECTORY_ENTRIES.map((entry) =>
      entryPresence(join(directory, entry), lstat),
    );
    if (signature.includes('indeterminate')) {
      return { kind: 'indeterminate', path: directory };
    }
    if (
      signature.filter((presence) => presence === 'present').length >= GIT_DIRECTORY_MATCH_THRESHOLD
    ) {
      return { kind: 'present', path: directory };
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return { kind: 'absent' };
    }
    directory = parent;
  }
}

/**
 * `lstat`, not `existsSync`: a `.git` symlink whose target is gone is Git data
 * that is present and broken, and `existsSync` follows the link and calls it
 * absent — the exact confusion this step exists to prevent. A stat failure that
 * is not ENOENT/ENOTDIR is `indeterminate` rather than absent, because "we could
 * not look" is not "there is nothing there".
 */
function entryPresence(path: string, lstat: LstatEntry): EntryPresence {
  try {
    lstat(path);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // ENOTDIR means a path component is a file, so the entry cannot exist.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'indeterminate';
  }
}
