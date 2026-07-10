# Isagi workflow SDK

The public TypeScript contract for authoring Isagi workflows.

```ts
import { defineWorkflow, done } from '@yourtechbudstudio/isagi-workflow-sdk';
```

Workflow packages should pin this package exactly. The workflow contract version is exported as
`workflowContractVersion`; package semver and the workflow contract version are separate.

The SDK contains definitions and small constructors. It does not load, verify, or run workflows.
