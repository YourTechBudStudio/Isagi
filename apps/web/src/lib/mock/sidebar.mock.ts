type SidebarItemState = "default" | "active" | "highlighted";

export type SidebarItem = {
  readonly id: string;
  readonly label: string;
  readonly state?: SidebarItemState;
};

export const homeSidebarItems: ReadonlyArray<SidebarItem> = [
  { id: "auth", label: "Refactor Auth Flow", state: "active" },
  { id: "dark-mode", label: 'Triage: "Dark mode toggle"' },
  { id: "db-research", label: "Research: sqlite vs turso" },
];

export const sessionSidebarItems: ReadonlyArray<SidebarItem> = [
  { id: "auth", label: "Refactor Auth Flow", state: "active" },
  {
    id: "dark-mode",
    label: 'Triage: "Dark mode toggle"',
    state: "highlighted",
  },
  { id: "db-research", label: "Research: sqlite vs turso" },
];
