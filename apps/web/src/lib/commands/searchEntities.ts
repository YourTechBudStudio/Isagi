import { homeCandidateTasks, homeSparks } from "@/lib/mock/home.mock";

import { type CommandId, COMMANDS } from "./commands";
import { fuzzyScore } from "./fuzzy";
import type { EntityType, SelectedOption } from "./types";

const MOCK_PROJECTS = [
  { id: "project-1", name: "Spark System MVP" },
  { id: "project-2", name: "Backend Foundation" },
  { id: "project-3", name: "Frontend Architecture" },
  { id: "project-4", name: "Deployment Pipeline" },
] as const;

export interface CommandSearchResult {
  readonly kind: "command";
  readonly id: CommandId;
  readonly label: string;
  readonly commandId: CommandId;
}

export interface EntitySearchResult extends SelectedOption {
  readonly kind: "entity";
}

export type SearchResult = CommandSearchResult | EntitySearchResult;

export interface EntitySearchResults {
  readonly recommended: ReadonlyArray<SearchResult>;
  readonly results: ReadonlyArray<SearchResult>;
}

type ScoredResult = {
  readonly score: number;
  readonly index: number;
  readonly item: SearchResult;
};

function sortByScore(results: ReadonlyArray<ScoredResult>): SearchResult[] {
  return [...results]
    .sort((a, b) => {
      if (a.score === b.score) {
        return a.index - b.index;
      }

      return b.score - a.score;
    })
    .map(result => result.item);
}

function scoreCommand(
  command: (typeof COMMANDS)[number],
  query: string,
): number | null {
  const scores: number[] = [];
  const labelScore = fuzzyScore(query, command.label);
  if (labelScore !== null) {
    scores.push(labelScore);
  }

  if (command.aliases) {
    for (const alias of command.aliases) {
      const aliasScore = fuzzyScore(query, alias);
      if (aliasScore !== null) {
        scores.push(aliasScore);
      }
    }
  }

  if (scores.length === 0) {
    return null;
  }

  return Math.max(...scores);
}

function createCommandSearchResult(
  command: (typeof COMMANDS)[number],
): CommandSearchResult {
  return {
    kind: "command",
    id: command.id,
    label: command.label,
    commandId: command.id,
  };
}

function createEntitySearchResult(option: SelectedOption): EntitySearchResult {
  return {
    kind: "entity",
    id: option.id,
    label: option.label,
  };
}

export function searchEntities(
  type: EntityType | null,
  filterText: string,
  contextId?: string,
): EntitySearchResults {
  const normalizedFilter = filterText.trim();
  const isFiltering = normalizedFilter.length > 0;

  if (!type) {
    if (!isFiltering) {
      return {
        recommended: [],
        results: COMMANDS.map(createCommandSearchResult),
      };
    }

    const matchedCommands: ScoredResult[] = COMMANDS.flatMap(
      (command, index) => {
        const score = scoreCommand(command, normalizedFilter);
        if (score === null) {
          return [];
        }

        return [
          {
            score,
            index,
            item: createCommandSearchResult(command),
          },
        ];
      },
    );

    return {
      recommended: [],
      results: sortByScore(matchedCommands),
    };
  }

  let allEntities: EntitySearchResult[] = [];

  switch (type) {
    case "project":
      allEntities = MOCK_PROJECTS.map(project =>
        createEntitySearchResult({ id: project.id, label: project.name }),
      );
      break;
    case "task":
      allEntities = homeCandidateTasks.map(task =>
        createEntitySearchResult({ id: task.id, label: task.title }),
      );
      break;
    case "spark":
      allEntities = homeSparks.map(spark =>
        createEntitySearchResult({ id: spark.id, label: spark.title }),
      );
      break;
  }

  if (isFiltering) {
    const scored: ScoredResult[] = allEntities.flatMap((entity, index) => {
      const score = fuzzyScore(normalizedFilter, entity.label);
      if (score === null) {
        return [];
      }

      return [{ score, index, item: entity }];
    });

    return {
      recommended: [],
      results: sortByScore(scored),
    };
  }

  let recommended: EntitySearchResult[] = [];
  let results = allEntities;

  if (contextId) {
    const recommendedItem = allEntities.find(entity => entity.id === contextId);
    if (recommendedItem) {
      recommended = [recommendedItem];
      results = allEntities.filter(entity => entity.id !== contextId);
    }
  }

  return { recommended, results };
}
