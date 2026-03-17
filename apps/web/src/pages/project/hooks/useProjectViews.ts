import { useEffect, useState } from "react";

import {
  type ProjectSavedView,
  type ProjectViewLayout,
  readProjectViewsState,
  writeProjectViewsState,
} from "@/lib/project-detail-storage";
import {
  createProjectView,
  deleteProjectView,
  duplicateProjectView,
  getSelectedProjectView,
  renameProjectView,
  selectProjectView,
  updateSelectedProjectView,
} from "@/lib/project-views";

type CreateProjectViewInput = {
  readonly name: string;
  readonly layout: ProjectViewLayout;
};

export function useProjectViews(projectId: string) {
  const [viewsState, setViewsState] = useState(() =>
    readProjectViewsState(projectId),
  );

  useEffect(() => {
    writeProjectViewsState(projectId, viewsState);
  }, [projectId, viewsState]);

  const selectedView = getSelectedProjectView(viewsState);

  const selectView = (viewId: string) => {
    setViewsState(prev => selectProjectView(prev, viewId));
  };

  const createView = (input: CreateProjectViewInput) => {
    setViewsState(prev => createProjectView(prev, input));
  };

  const renameView = (viewId: string, name: string) => {
    setViewsState(prev => renameProjectView(prev, viewId, name));
  };

  const duplicateView = (viewId: string) => {
    setViewsState(prev => duplicateProjectView(prev, viewId));
  };

  const deleteView = (viewId: string) => {
    setViewsState(prev => deleteProjectView(prev, viewId));
  };

  const updateSelectedView = (
    updater: (view: ProjectSavedView) => ProjectSavedView,
  ) => {
    setViewsState(prev => updateSelectedProjectView(prev, updater));
  };

  return {
    views: viewsState.views,
    selectedView,
    selectView,
    createView,
    renameView,
    duplicateView,
    deleteView,
    updateSelectedView,
  };
}
