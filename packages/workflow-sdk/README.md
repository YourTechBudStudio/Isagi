# Isagi workflow SDK

The public TypeScript contract for authoring Isagi workflows.

```ts
import { createGraph, defineWorkflow, operation } from '@yourtechbudstudio/isagi-workflow-sdk';
```

Pin this package exactly. The current release is `0.1.0`, paired with
`@yourtechbudstudio/isagi-workflow-verifier` at the version that package documents. The workflow
contract version is exported as `workflowContractVersion`; package semver and the workflow contract
version are separate axes.

A workflow is a graph: parameterized graphs with reducer-owned state, operation and subgraph nodes,
one declared router per node, and terminal outcomes. Graphs compose and are reusable, so one
definition can be invoked from several places and each invocation is inspected on its own.

The SDK contains definitions and small constructors. It does not load, verify, or run workflows. For
the full authoring guide, use Isagi's installed `isagi-docs` skill.
