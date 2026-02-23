import { homeFocusQueueItems, homeSparks } from "@/lib/mock/home.mock";

import { fuzzyScore } from "./fuzzy";
import { COMMANDS } from "./registry";
import type { ArgumentType, CommandDef } from "./types";

// Extracted from mock data to simulate a normalized list of entities
const MOCK_PROJECTS = [
  { id: "project-1", name: "Spark System MVP" },
  { id: "project-2", name: "Backend Foundation" },
  { id: "project-3", name: "Frontend Architecture" },
  { id: "project-4", name: "Deployment Pipeline" },
];

export interface SearchResult {
  id: string;
  label: string;
}

export interface EntitySearchResults {
  recommended: SearchResult[];
  results: SearchResult[];
}

type ScoredResult = {
  score: number;
  index: number;
  item: SearchResult;
};

function sortByScore(results: ScoredResult[]): SearchResult[] {
  return results
    .sort((a, b) => {
      if (a.score === b.score) {
        return a.index - b.index;
      }
      return b.score - a.score;
    })
    .map(result => result.item);
}

function scoreCommand(command: CommandDef, query: string): number | null {
  const scores: number[] = [];
  const labelScore = fuzzyScore(query, command.label);
  if (labelScore !== null) scores.push(labelScore);

  if (command.aliases) {
    for (const alias of command.aliases) {
      const aliasScore = fuzzyScore(query, alias);
      if (aliasScore !== null) scores.push(aliasScore);
    }
  }

  if (scores.length === 0) return null;
  return Math.max(...scores);
}

export function searchEntities(
  type: ArgumentType | null,
  filterText: string,
  contextId?: string,
): EntitySearchResults {
  const normalizedFilter = filterText.trim();
  const isFiltering = normalizedFilter.length > 0;

  // If no type is provided, we default to searching the commands registry itself
  if (!type) {
    if (!isFiltering) {
      return {
        recommended: [],
        results: COMMANDS.map(cmd => ({ id: cmd.id, label: cmd.label })),
      };
    }

    const matchedCommands = COMMANDS.map((cmd, index) => {
      const score = scoreCommand(cmd, normalizedFilter);
      if (score === null) return null;
      return { score, index, item: { id: cmd.id, label: cmd.label } };
    }).filter((result): result is ScoredResult => result !== null);

    return {
      recommended: [],
      results: sortByScore(matchedCommands),
    };
  }

  let allEntities: SearchResult[] = [];

  switch (type) {
    case "project":
      allEntities = MOCK_PROJECTS.map(p => ({ id: p.id, label: p.name }));
      break;
    case "task":
      allEntities = homeFocusQueueItems.map(t => ({
        id: t.id,
        label: t.title,
      }));
      break;
    case "spark":
      allEntities = homeSparks.map(s => ({ id: s.id, label: s.title }));
      break;
    case "text":
      return { recommended: [], results: [] };
  }

  // Filter based on input
  if (isFiltering) {
    const scored = allEntities
      .map((entity, index) => {
        const score = fuzzyScore(normalizedFilter, entity.label);
        if (score === null) return null;
        return { score, index, item: entity };
      })
      .filter((result): result is ScoredResult => result !== null);

    return {
      recommended: [],
      results: sortByScore(scored),
    };
  }

  // Extract recommended if we have a contextId and we're NOT actively filtering
  let recommended: SearchResult[] = [];
  let results = allEntities;

  if (!isFiltering && contextId) {
    const recommendedItem = allEntities.find(e => e.id === contextId);
    if (recommendedItem) {
      recommended = [recommendedItem];
      results = allEntities.filter(e => e.id !== contextId);
    }
  }

  return { recommended, results };
}
