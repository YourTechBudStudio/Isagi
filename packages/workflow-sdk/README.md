# Isagi workflow SDK

The public TypeScript contract for authoring Isagi workflows.

```ts
import { defineWorkflow, done } from "@yourtechbudstudio/isagi-workflow-sdk";
```

Pin this package exactly. The current release is `0.0.1`, paired with
`@yourtechbudstudio/isagi-workflow-verifier` at the version that package documents. The workflow
contract version is exported as `workflowContractVersion`; package semver and the workflow contract
version are separate axes.

The SDK contains definitions and small constructors. It does not load, verify, or run workflows. For
the full authoring guide, use Isagi's installed `isagi-docs` skill.
