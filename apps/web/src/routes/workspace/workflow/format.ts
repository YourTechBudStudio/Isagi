/**
 * Presentation values the inspector's components share.
 *
 * Their own module because a component file that also exports constants breaks fast refresh, and
 * because a size shown beside a payload tab and a size shown on a card have to agree.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How far the dock may be resized.
 *
 * Bounded in both directions: a dock dragged to nothing is a panel a person cannot find again, and
 * one dragged past the window takes the graph with it.
 */
export const dockMinHeight = 140;
export const dockMaxHeight = 620;
