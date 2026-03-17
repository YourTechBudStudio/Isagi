import { useState } from "react";

import { collectUniqueLabels } from "@/lib/labels";
import type { MockTask } from "@/lib/mock/project.mock";

export function useProjectTasks(initialTasks: ReadonlyArray<MockTask>) {
  const [tasks, setTasks] = useState<Array<MockTask>>([...initialTasks]);

  const updateTask = (updatedTask: MockTask) => {
    setTasks(prev =>
      prev.map(task => (task.id === updatedTask.id ? updatedTask : task)),
    );
  };

  const collectionOptions = Array.from(
    new Set(
      tasks
        .map(task => task.collection)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const availableLabels = collectUniqueLabels(
    tasks.flatMap(task => task.labels),
  );

  return {
    tasks,
    updateTask,
    collectionOptions,
    availableLabels,
  };
}
