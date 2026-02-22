import type { CommandDef } from "./types";

export const COMMANDS: CommandDef[] = [
  {
    id: "create-task",
    label: "Create Task",
    aliases: ["new task", "add task", "todo"],
    arguments: [
      {
        id: "projectId",
        type: "project",
        placeholder: "Select a project...",
        labelPrefix: "Project:",
      },
    ],
  },
  {
    id: "start-planning-session",
    label: "Start Planning Session",
    aliases: ["plan", "planning"],
    arguments: [
      {
        id: "projectId",
        type: "project",
        placeholder: "Select a project to plan...",
        labelPrefix: "Project:",
      },
    ],
  },
  {
    id: "start-work-session",
    label: "Start Work Session",
    aliases: ["work", "code"],
    arguments: [
      {
        id: "projectId",
        type: "project",
        placeholder: "Select a project to work on...",
        labelPrefix: "Project:",
      },
    ],
  },
  {
    id: "create-project",
    label: "Create Project",
    aliases: ["new project", "add project"],
    arguments: [
      {
        id: "name",
        type: "text",
        placeholder: "Enter project name...",
        labelPrefix: "Name:",
      },
    ],
  },
  {
    id: "log-debug-info",
    label: "Log Debug Info",
    aliases: ["debug"],
    arguments: [],
  },
];
