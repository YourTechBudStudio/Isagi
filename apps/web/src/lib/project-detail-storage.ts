export type ProjectViewMode = "board" | "list";
export type ProjectPriorityFilter = "all" | "high" | "medium" | "low";
export type ProjectSortKey = "due_date" | "priority";

export type ProjectSavedViewState = {
  readonly viewMode: ProjectViewMode;
  readonly priorityFilter: ProjectPriorityFilter;
  readonly collectionFilter: string;
  readonly sortKey: ProjectSortKey;
};

export const DEFAULT_PROJECT_VIEW_STATE: ProjectSavedViewState = {
  viewMode: "board",
  priorityFilter: "all",
  collectionFilter: "all",
  sortKey: "due_date",
};

function getStorageKey(projectId: string): string {
  return `isagi.project-detail.${projectId}.view-state`;
}

export function readProjectViewState(projectId: string): ProjectSavedViewState {
  if (typeof window === "undefined") {
    return DEFAULT_PROJECT_VIEW_STATE;
  }

  const rawValue = window.localStorage.getItem(getStorageKey(projectId));
  if (!rawValue) {
    return DEFAULT_PROJECT_VIEW_STATE;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<ProjectSavedViewState>;

    return {
      viewMode:
        parsed.viewMode === "list" || parsed.viewMode === "board"
          ? parsed.viewMode
          : DEFAULT_PROJECT_VIEW_STATE.viewMode,
      priorityFilter:
        parsed.priorityFilter === "all" ||
        parsed.priorityFilter === "high" ||
        parsed.priorityFilter === "medium" ||
        parsed.priorityFilter === "low"
          ? parsed.priorityFilter
          : DEFAULT_PROJECT_VIEW_STATE.priorityFilter,
      collectionFilter:
        typeof parsed.collectionFilter === "string"
          ? parsed.collectionFilter
          : DEFAULT_PROJECT_VIEW_STATE.collectionFilter,
      sortKey:
        parsed.sortKey === "priority" || parsed.sortKey === "due_date"
          ? parsed.sortKey
          : DEFAULT_PROJECT_VIEW_STATE.sortKey,
    };
  } catch {
    return DEFAULT_PROJECT_VIEW_STATE;
  }
}

export function writeProjectViewState(
  projectId: string,
  state: ProjectSavedViewState,
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getStorageKey(projectId), JSON.stringify(state));
}
