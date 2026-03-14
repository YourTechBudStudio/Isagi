import { projectRegistrationBackend } from "@/services/projectRegistrationBackend";

import type {
  CommandController,
  CommandStartResult,
  CommandSubmitInput,
  CommandSubmitResult,
  FileStep,
  FileValue,
  HistoryFrame,
  TextStep,
} from "../types";

type AddProjectDraftState = {
  readonly file: FileValue;
  readonly inferredName: string;
};

function createProjectPathStep(initialDraft = ""): FileStep {
  return {
    id: "projectPath",
    kind: "file",
    placeholder: "Paste a server repo path...",
    labelPrefix: "Path:",
    initialDraft,
    emptyErrorMessage: "Enter a repo path to continue.",
    selectionMode: "directory",
  };
}

function createNameStep(
  inferredName: string,
  initialDraft = inferredName,
): TextStep {
  return {
    id: "name",
    kind: "text",
    placeholder: "Confirm project name...",
    labelPrefix: "Name:",
    initialDraft,
    emptyErrorMessage: "Give this project a name before continuing.",
  };
}

function getHistoryFrameById(
  history: ReadonlyArray<HistoryFrame>,
  stepId: string,
): HistoryFrame | undefined {
  return history.find(frame => frame.step.id === stepId);
}

function isFileValue(value: unknown): value is FileValue {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const fileValue = value as Partial<FileValue>;
  return (
    typeof fileValue.path === "string" &&
    (fileValue.kind === "file" || fileValue.kind === "dir")
  );
}

export function createAddProjectController(): CommandController {
  let validatedProject: AddProjectDraftState | null = null;

  return {
    start(): CommandStartResult {
      return {
        type: "step",
        step: createProjectPathStep(),
      };
    },

    async submit(input: CommandSubmitInput): Promise<CommandSubmitResult> {
      if (input.step.id === "projectPath") {
        const validation = await projectRegistrationBackend.validateProjectPath(
          {
            rawPath: input.draft,
          },
        );

        if (validation.status === "invalid") {
          return {
            type: "stay",
            error: validation.message,
          };
        }

        if (validation.status === "duplicate") {
          return {
            type: "close",
            effect: {
              variant: "message",
              message: "Project already registered.",
              action: {
                label: "Open project",
                onClick: () => {
                  console.log("Open project requested", validation.project);
                },
              },
            },
          };
        }

        validatedProject = {
          file: validation.file,
          inferredName: validation.inferredName,
        };

        return {
          type: "next",
          frame: {
            step: input.step,
            draft: input.draft,
            value: {
              value: validation.file,
              label: validation.file.path,
            },
          },
          step: createNameStep(validation.inferredName),
        };
      }

      if (input.step.id !== "name") {
        return { type: "close" };
      }

      const pathFrame = getHistoryFrameById(input.history, "projectPath");
      const fallbackFile = isFileValue(pathFrame?.value.value)
        ? pathFrame.value.value
        : null;
      const file = validatedProject?.file ?? fallbackFile;

      if (!file) {
        return {
          type: "close",
          effect: {
            variant: "error",
            message: "Project path is missing. Start the flow again.",
          },
        };
      }

      const trimmedName = input.draft.trim();
      const registration = await projectRegistrationBackend.registerProject({
        name: trimmedName,
        file,
      });

      console.log("Register project", registration);

      return {
        type: "complete",
        frame: {
          step: input.step,
          draft: input.draft,
          value: {
            value: trimmedName,
            label: trimmedName,
          },
        },
        effect: {
          variant: "success",
          message: "Project added.",
          action: {
            label: "Open project",
            onClick: () => {
              console.log("Open project requested", registration);
            },
          },
          cancel: {
            label: "Open settings",
            onClick: () => {
              console.log("Open project settings requested", registration);
            },
          },
        },
      };
    },
  };
}
