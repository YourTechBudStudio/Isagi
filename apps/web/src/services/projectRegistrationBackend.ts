import type { FileValue } from "@/lib/commands/types";

type RegisteredProjectRecord = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
};

export interface ProjectRegistrationSuccess {
  readonly id: string;
  readonly name: string;
  readonly file: FileValue;
}

export type ValidateProjectPathResponse =
  | {
      readonly status: "valid";
      readonly file: FileValue;
      readonly inferredName: string;
    }
  | {
      readonly status: "duplicate";
      readonly project: {
        readonly id: string;
        readonly name: string;
      };
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    };

const MOCK_HOME_DIRECTORY = "/home/isagi";

const MOCK_REGISTERED_PROJECTS: ReadonlyArray<RegisteredProjectRecord> = [
  {
    id: "project-spark-system",
    name: "Spark System MVP",
    path: "/srv/repos/isagi",
  },
  {
    id: "project-backend-foundation",
    name: "Backend Foundation",
    path: `${MOCK_HOME_DIRECTORY}/code/backend-foundation`,
  },
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function expandHomePath(path: string): string {
  if (path === "~") {
    return MOCK_HOME_DIRECTORY;
  }

  if (path.startsWith("~/")) {
    return `${MOCK_HOME_DIRECTORY}${path.slice(1)}`;
  }

  return path;
}

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const expanded = expandHomePath(trimmed);
  const collapsedSlashes = expanded.replace(/\/{2,}/g, "/");

  if (collapsedSlashes.length > 1 && collapsedSlashes.endsWith("/")) {
    return collapsedSlashes.slice(0, -1);
  }

  return collapsedSlashes;
}

function inferProjectNameFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const folderName = segments[segments.length - 1] ?? "Project";

  return folderName
    .split(/[-_]+/)
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function buildMockValidationResponse(
  path: string,
): ValidateProjectPathResponse {
  if (!(path.startsWith("/") || path === "~" || path.startsWith("~/"))) {
    return {
      status: "invalid",
      message:
        "Use an absolute server path or `~`. Relative paths are not supported.",
    };
  }

  const canonicalPath = normalizePath(path);
  const duplicateProject = MOCK_REGISTERED_PROJECTS.find(
    project => project.path === canonicalPath,
  );

  if (duplicateProject) {
    return {
      status: "duplicate",
      project: {
        id: duplicateProject.id,
        name: duplicateProject.name,
      },
    };
  }

  if (/missing|does-not-exist|unknown/i.test(canonicalPath)) {
    return {
      status: "invalid",
      message: "That path does not exist on the server filesystem.",
    };
  }

  if (/not-repo|scratch|downloads/i.test(canonicalPath)) {
    return {
      status: "invalid",
      message: "Isagi currently works only with existing local git repos.",
    };
  }

  if (
    /(\/src|\/docs|\/packages|\/apps|\/tests|\/scripts)(\/|$)/.test(
      canonicalPath,
    )
  ) {
    return {
      status: "invalid",
      message:
        "That looks like a nested subpath. Register the repo root instead.",
    };
  }

  return {
    status: "valid",
    file: {
      path: canonicalPath,
      kind: "dir",
    },
    inferredName: inferProjectNameFromPath(canonicalPath),
  };
}

export const projectRegistrationBackend = {
  async validateProjectPath(
    input: Readonly<{ rawPath: string }>,
  ): Promise<ValidateProjectPathResponse> {
    await sleep(180);
    return buildMockValidationResponse(input.rawPath);
  },

  async registerProject(
    input: Readonly<{ name: string; file: FileValue }>,
  ): Promise<ProjectRegistrationSuccess> {
    await sleep(160);

    return {
      id: `project-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: input.name,
      file: input.file,
    };
  },
};
