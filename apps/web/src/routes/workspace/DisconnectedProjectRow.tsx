import type { MissingProject } from '../../lib/workspace/types.js';
import { ProjectGlyph } from './ProjectGlyph.js';

/**
 * A disconnected project in the rail's Disconnected section — promoted to a
 * single selectable row: dashed error glyph + name, nothing else. The path, the
 * reason, and the recovery actions all live in the canvas, which has the room.
 * Selecting it shows that canvas state.
 */
export function DisconnectedProjectRow({
  project,
  active,
  onSelect,
}: {
  project: MissingProject;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition duration-micro ease-expo hover:bg-error/8 ${
        active ? 'bg-error/10' : ''
      }`}
    >
      <ProjectGlyph glyph={project.glyph} disconnected />
      <span
        className={`truncate text-[13px] ${active ? 'font-semibold text-fg' : 'font-medium text-fg-muted'}`}
      >
        {project.name}
      </span>
    </button>
  );
}
