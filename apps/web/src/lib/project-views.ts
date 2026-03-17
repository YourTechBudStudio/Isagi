import {
  createProjectSavedViewId,
  DEFAULT_PROJECT_VIEWS_STATE,
  getDuplicatedProjectViewName,
  getNextProjectViewName,
  type ProjectSavedView,
  type ProjectViewLayout,
  type ProjectViewsState,
} from "@/lib/project-detail-storage";

type CreateProjectViewInput = {
  readonly name: string;
  readonly layout: ProjectViewLayout;
};

function getFallbackView(): ProjectSavedView {
  return DEFAULT_PROJECT_VIEWS_STATE.views[0];
}

export function getSelectedProjectView(
  state: ProjectViewsState,
): ProjectSavedView {
  return (
    state.views.find(view => view.id === state.selectedViewId) ??
    state.views[0] ??
    getFallbackView()
  );
}

export function selectProjectView(
  state: ProjectViewsState,
  viewId: string,
): ProjectViewsState {
  const hasView = state.views.some(view => view.id === viewId);
  if (!hasView) {
    return state;
  }

  return {
    ...state,
    selectedViewId: viewId,
  };
}

export function updateSelectedProjectView(
  state: ProjectViewsState,
  updater: (view: ProjectSavedView) => ProjectSavedView,
): ProjectViewsState {
  const selectedView = getSelectedProjectView(state);

  return {
    ...state,
    views: state.views.map(view =>
      view.id === selectedView.id ? updater(selectedView) : view,
    ),
  };
}

export function createProjectView(
  state: ProjectViewsState,
  input: CreateProjectViewInput,
): ProjectViewsState {
  const sourceView = getSelectedProjectView(state);
  const nextView: ProjectSavedView = {
    ...sourceView,
    id: createProjectSavedViewId(),
    name: input.name || getNextProjectViewName(input.layout, state.views),
    layout: input.layout,
  };

  return {
    selectedViewId: nextView.id,
    views: [...state.views, nextView],
  };
}

export function renameProjectView(
  state: ProjectViewsState,
  viewId: string,
  name: string,
): ProjectViewsState {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return state;
  }

  return {
    ...state,
    views: state.views.map(view =>
      view.id === viewId ? { ...view, name: trimmedName } : view,
    ),
  };
}

export function duplicateProjectView(
  state: ProjectViewsState,
  viewId: string,
): ProjectViewsState {
  const sourceView = state.views.find(view => view.id === viewId);
  if (!sourceView) {
    return state;
  }

  const duplicatedView: ProjectSavedView = {
    ...sourceView,
    id: createProjectSavedViewId(),
    name: getDuplicatedProjectViewName(sourceView.name, state.views),
  };

  const sourceIndex = state.views.findIndex(view => view.id === viewId);
  const nextViews = [...state.views];
  nextViews.splice(sourceIndex + 1, 0, duplicatedView);

  return {
    selectedViewId: duplicatedView.id,
    views: nextViews,
  };
}

export function deleteProjectView(
  state: ProjectViewsState,
  viewId: string,
): ProjectViewsState {
  if (state.views.length <= 1) {
    return state;
  }

  const deletedIndex = state.views.findIndex(view => view.id === viewId);
  if (deletedIndex === -1) {
    return state;
  }

  const nextViews = state.views.filter(view => view.id !== viewId);
  if (nextViews.length === 0) {
    return state;
  }

  const nextSelectedView =
    state.selectedViewId === viewId
      ? nextViews[Math.min(deletedIndex, nextViews.length - 1)]
      : (nextViews.find(view => view.id === state.selectedViewId) ??
        nextViews[0]);

  return {
    selectedViewId: nextSelectedView.id,
    views: nextViews,
  };
}
