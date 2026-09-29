# Isagi workflow SDK

The public TypeScript contract for authoring Isagi workflows.

```ts
import { createGraph, defineWorkflow, operation } from '@yourtechbudstudio/isagi-workflow-sdk';
```

Pin this package exactly. The current release is `0.1.1`, paired with `@yourtechbudstudio/isagi-workflow-verifier` `0.1.1`. The workflow contract version is exported as `workflowContractVersion` (currently `5`); package semver and the workflow contract version are separate axes.

A workflow is a graph: parameterized graphs with reducer-owned state, operation, subgraph and checkpoint nodes, one declared router per node, and terminal outcomes. Graphs compose and are reusable, so one definition can be invoked from several places and each invocation is inspected on its own.

Operation callbacks should do their preparation, perform one side effect, and return. Every side effect is logged in the run's history, but a Retry of a callback that failed before returning runs it again. Checkpoint nodes snapshot the current commit plus exactly the files and folders their plan names; nothing is inherited from earlier checkpoints.

The SDK contains definitions and small constructors. It does not load, verify, or run workflows. For the full authoring guide, use Isagi's installed `isagi-docs` skill.
