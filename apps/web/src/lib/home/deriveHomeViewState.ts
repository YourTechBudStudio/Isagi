import type { HomeScreenData } from "@/lib/mock/home.mock";

export type HomeViewState =
  | "happy-path"
  | "no-projects"
  | "no-resumable"
  | "no-sessions";

export function deriveHomeViewState(data: HomeScreenData): HomeViewState {
  if (data.projects.length === 0) {
    return "no-projects";
  }

  if (data.resumeContext) {
    return "happy-path";
  }

  if (data.candidateTasks.length > 0) {
    return "no-resumable";
  }

  return "no-sessions";
}
