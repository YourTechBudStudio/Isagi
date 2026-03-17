export type ProjectViewLayout = "board" | "list";
export type ProjectPriorityFilter = "all" | "high" | "medium" | "low";
export type ProjectSortKey = "due_date" | "priority";
export type ProjectGroupBy = "status";

export type ProjectSavedView = {
  readonly id: string;
  readonly name: string;
  readonly layout: ProjectViewLayout;
  readonly groupBy: ProjectGroupBy;
  readonly priorityFilter: ProjectPriorityFilter;
  readonly collectionFilter: string;
  readonly sortKey: ProjectSortKey;
};

export type ProjectViewsState = {
  readonly selectedViewId: string;
  readonly views: ReadonlyArray<ProjectSavedView>;
};

const DEFAULT_BOARD_VIEW_ID = "view-board";
const DEFAULT_LIST_VIEW_ID = "view-list";

function getStorageKey(projectId: string): string {
  return `isagi.project-detail.${projectId}.view-state`;
}

function createDefaultViews(): Array<ProjectSavedView> {
  return [
    {
      id: DEFAULT_BOARD_VIEW_ID,
      name: "Board",
      layout: "board",
      groupBy: "status",
      priorityFilter: "all",
      collectionFilter: "all",
      sortKey: "due_date",
    },
    {
      id: DEFAULT_LIST_VIEW_ID,
      name: "List",
      layout: "list",
      groupBy: "status",
      priorityFilter: "all",
      collectionFilter: "all",
      sortKey: "due_date",
    },
  ];
}

export const DEFAULT_PROJECT_VIEWS_STATE: ProjectViewsState = {
  selectedViewId: DEFAULT_BOARD_VIEW_ID,
  views: createDefaultViews(),
};

function normalizeLayout(value: unknown): ProjectViewLayout {
  return value === "list" ? "list" : "board";
}

function normalizePriorityFilter(value: unknown): ProjectPriorityFilter {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "all";
}

function normalizeSortKey(value: unknown): ProjectSortKey {
  return value === "priority" ? "priority" : "due_date";
}

function normalizeGroupBy(_value: unknown): ProjectGroupBy {
  return "status";
}

function normalizeSavedView(
  value: unknown,
  fallbackIndex: number,
): ProjectSavedView | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectSavedView>;
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) {
    return null;
  }

  return {
    id:
      typeof candidate.id === "string" && candidate.id.trim().length > 0
        ? candidate.id
        : `view-${fallbackIndex + 1}`,
    name,
    layout: normalizeLayout(candidate.layout),
    groupBy: normalizeGroupBy(candidate.groupBy),
    priorityFilter: normalizePriorityFilter(candidate.priorityFilter),
    collectionFilter:
      typeof candidate.collectionFilter === "string"
        ? candidate.collectionFilter
        : "all",
    sortKey: normalizeSortKey(candidate.sortKey),
  };
}

export function readProjectViewsState(projectId: string): ProjectViewsState {
  if (typeof window === "undefined") {
    return DEFAULT_PROJECT_VIEWS_STATE;
  }

  const rawValue = window.localStorage.getItem(getStorageKey(projectId));
  if (!rawValue) {
    return DEFAULT_PROJECT_VIEWS_STATE;
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_PROJECT_VIEWS_STATE;
    }

    const candidate = parsed as Partial<ProjectViewsState>;
    const normalizedViews = Array.isArray(candidate.views)
      ? candidate.views
          .map((view, index) => normalizeSavedView(view, index))
          .filter((view): view is ProjectSavedView => view !== null)
      : [];

    if (normalizedViews.length === 0) {
      return DEFAULT_PROJECT_VIEWS_STATE;
    }

    const selectedViewId =
      typeof candidate.selectedViewId === "string" &&
      normalizedViews.some(view => view.id === candidate.selectedViewId)
        ? candidate.selectedViewId
        : normalizedViews[0].id;

    return {
      selectedViewId,
      views: normalizedViews,
    };
  } catch {
    return DEFAULT_PROJECT_VIEWS_STATE;
  }
}

export function writeProjectViewsState(
  projectId: string,
  state: ProjectViewsState,
): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getStorageKey(projectId), JSON.stringify(state));
}

export function createProjectSavedViewId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `view-${crypto.randomUUID()}`;
  }

  return `view-${Date.now()}`;
}

export function getNextProjectViewName(
  layout: ProjectViewLayout,
  existingViews: ReadonlyArray<ProjectSavedView>,
): string {
  const baseName = layout === "board" ? "Board" : "List";
  const usedNames = new Set(existingViews.map(view => view.name.toLowerCase()));

  if (!usedNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  let suffix = 2;
  while (usedNames.has(`${baseName.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }

  return `${baseName} ${suffix}`;
}
