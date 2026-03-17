import { createAddProjectController } from "./controllers/addProject";
import { defineFlowCommand } from "./flow";
import type { CommandController, CommandDefinition } from "./types";

function defineCommand<const TId extends string>(
  command: CommandDefinition<TId>,
): CommandDefinition<TId> {
  return command;
}

export const COMMANDS = [
  defineCommand({
    id: "create-task",
    label: "Create Task",
    aliases: ["new task", "add task", "todo"],
    createController: () =>
      defineFlowCommand({
        steps: [
          {
            id: "projectId",
            step: {
              id: "projectId",
              kind: "entity-search",
              entityType: "project",
              placeholder: "Select a project...",
              labelPrefix: "Project:",
            },
          },
        ],
        onComplete: ({ values }) => {
          console.log("Create task command invoked", values);
          return {
            variant: "message",
            message: "Create task is coming soon.",
          };
        },
      }),
  }),
  defineCommand({
    id: "start-shaping-session",
    label: "Start Project Shaping Session",
    aliases: ["shape", "shaping", "plan"],
    createController: () =>
      defineFlowCommand({
        steps: [
          {
            id: "projectId",
            step: {
              id: "projectId",
              kind: "entity-search",
              entityType: "project",
              placeholder: "Select a project to shape up...",
              labelPrefix: "Project:",
            },
          },
        ],
        onComplete: ({ values }) => {
          console.log("Start shaping session command invoked", values);
          return {
            variant: "message",
            message: "Shaping sessions are coming soon.",
          };
        },
      }),
  }),
  defineCommand({
    id: "start-work-session",
    label: "Start Work Session",
    aliases: ["work", "code", "start a session"],
    createController: () =>
      defineFlowCommand({
        steps: [
          {
            id: "projectId",
            step: {
              id: "projectId",
              kind: "entity-search",
              entityType: "project",
              placeholder: "Select a project to work on...",
              labelPrefix: "Project:",
            },
          },
        ],
        onComplete: ({ values }) => {
          console.log("Start work session command invoked", values);
          return {
            variant: "message",
            message: "Start a session is coming soon.",
          };
        },
      }),
  }),
  defineCommand({
    id: "add-project",
    label: "Add Project",
    aliases: ["new project", "create project", "register project"],
    createController: () => createAddProjectController(),
  }),
  defineCommand({
    id: "log-debug-info",
    label: "Log Debug Info",
    aliases: ["debug"],
    createController: () =>
      defineFlowCommand({
        steps: [],
        onComplete: () => {
          console.log("Log debug info command invoked");
          return {
            variant: "message",
            message: "Debug info dumped to the console.",
          };
        },
      }),
  }),
  defineCommand({
    id: "capture-spark",
    label: "Capture Spark",
    aliases: ["new spark", "spark", "idea"],
    createController: () =>
      defineFlowCommand({
        steps: [
          {
            id: "content",
            step: {
              id: "content",
              kind: "markdown",
              placeholder: "Dump your brain cache...",
              labelPrefix: "Spark:",
              emptyErrorMessage: "You cannot submit an empty spark.",
            },
          },
        ],
        onComplete: ({ values }) => {
          console.log("Capture spark command invoked", values);
          return {
            variant: "success",
            message: "Spark captured.",
            action: {
              label: "Open triage now",
              onClick: () => {
                console.log("Open spark triage requested", values);
              },
            },
          };
        },
      }),
  }),
] as const;

export type CommandId = (typeof COMMANDS)[number]["id"];

const commandsById = new Map<CommandId, (typeof COMMANDS)[number]>(
  COMMANDS.map(command => [command.id, command]),
);

export function getCommand(commandId: CommandId): (typeof COMMANDS)[number] {
  return commandsById.get(commandId)!;
}

export function createCommandController(
  commandId: CommandId,
): CommandController {
  return getCommand(commandId).createController();
}
