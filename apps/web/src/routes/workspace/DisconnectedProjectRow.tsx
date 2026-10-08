import { ContextMenu } from '../../components/ContextMenu.js';
import { useCommandDispatcher } from '../../lib/palette/dispatcher.js';
import type { MissingProject } from '../../lib/workspace/types.js';
import { projectMenuItems } from './project-menu.js';
import { ProjectGlyph } from './ProjectGlyph.js';

/**
 * A disconnected project in the rail's Disconnected section — promoted to a
 * single selectable row: dashed error glyph + name, nothing else. The path, the
 * reason, and the recovery actions all live in the canvas, which has the room.
 * Selecting it shows that canvas state. Right-click offers the same project menu
 * as a present project's header.
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
  const dispatchCommand = useCommandDispatcher();
  return (
    <ContextMenu items={projectMenuItems(project.id, dispatchCommand)}>
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
    </ContextMenu>
  );
}
