import { homeFocusQueueItems, homeSparks } from "@/lib/mock/home.mock";

import { COMMANDS } from "./registry";
import type { ArgumentType } from "./types";

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

export function searchEntities(
  type: ArgumentType | null,
  filterText: string,
  contextId?: string,
): EntitySearchResults {
  const normalizedFilter = filterText.toLowerCase().trim();

  // If no type is provided, we default to searching the commands registry itself
  if (!type) {
    const matchedCommands = COMMANDS.filter(
      cmd =>
        cmd.label.toLowerCase().includes(normalizedFilter) ||
        cmd.aliases?.some(alias =>
          alias.toLowerCase().includes(normalizedFilter),
        ),
    );
    return {
      recommended: [],
      results: matchedCommands.map(cmd => ({ id: cmd.id, label: cmd.label })),
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
  let filtered = allEntities;
  if (normalizedFilter) {
    filtered = allEntities.filter(e =>
      e.label.toLowerCase().includes(normalizedFilter),
    );
  }

  // Extract recommended if we have a contextId and we're NOT actively filtering
  let recommended: SearchResult[] = [];
  let results = filtered;

  if (!normalizedFilter && contextId) {
    const recommendedItem = allEntities.find(e => e.id === contextId);
    if (recommendedItem) {
      recommended = [recommendedItem];
      results = filtered.filter(e => e.id !== contextId);
    }
  }

  return { recommended, results };
}
