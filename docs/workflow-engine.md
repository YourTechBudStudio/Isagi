# Workflow Subsystem

## Purpose and ownership

Workflows coordinate long-running agent work through declared graphs. Authors put the sequence, routing, and human gates in TypeScript; agents perform the work and supply judgments that the graph can act on.

The runtime owns execution, saved state, code versions, external-operation tracking, and recovery. Author code uses the TypeScript SDK and Promise-based capabilities; the runtime manages operational lifecycles internally through Effect. The web client presents run state and sends explicit controls. A surface is where a run is shown; the run has its own durable identity.

This overview explains the subsystem's model and guarantees. Concrete authoring types, API shapes, persistence, and execution mechanics live in the code.

## Graphs and runs

A workflow combines its launch inputs and validation with a root graph. Graphs declare operations, nested graphs, routing edges, and completion outcomes. Each graph invocation owns private state; pure per-field reducers apply updates, and mappings pass parameters into children and completed outputs back to parents. Graph execution is sequential, with explicit waits for external work or human input.

Operations perform work and can complete immediately or return an explicit wait. Pure routing edges consume the resulting event and choose a declared destination. A callback or reducer exception fails the execution segment; an agent reporting failure is an event the graph can handle through ordinary routing. Reducer failures do not partially apply graph state.

One run contains the whole composed graph. A graph definition describes reusable structure, a frame represents one invocation of that graph, a node execution represents one visit, and an attempt records one try at an execution segment. Repeated visits and retries retain distinct history under the same run.

Workflows are independently built and verified packages discovered from global, configured, and project sources. Higher-priority sources own matching workflow keys; a broken winning package does not silently fall back to another definition. Users launch workflows through the command palette, and runtime API callers supply an explicit destination.

Verification checks declared structure and produces the artifact the runtime loads. It does not prove that author routing is correct, loops terminate, or arbitrary author code is safe. Author callbacks run as trusted code inside the runtime.

## Durable continuation and code versions

The runtime persists graph state and the exact position from which execution should continue. Completed transitions are committed with their history. Recovery follows that saved position without replaying completed history.

The position distinguishes operational work from routing and applying a child's completed output. A failed route can therefore be retried without sending the preceding prompt again, and a failed parent mapping can be retried without rerunning the completed child.

A run is pinned to an immutable verified artifact containing its composed code. Resume continues under that pin; a missing or corrupt pinned artifact is a recovery failure, not permission to load newer code. Explicit Retry can adopt the latest verified version after checking that the saved structural locations still exist. Rejected loading or structural validation leaves the saved execution and pin unchanged. Authors remain responsible for the meaning and compatibility of saved state, events, outputs, and capability calls across edits. Earlier attempts retain the code identity under which they ran.

## External work and recovery

Runtime capabilities record durable operation intents and receipts separately from graph transitions. When an unfinished callback is entered again, matching recorded calls reuse known receipts rather than repeating their effects. New visits to a node represent new work.

External dispatch and database writes cannot form one atomic transaction. Recovery reconciles durable evidence and blocks dependent work when delivery remains unknown. Retry does not authorize a blind resend. Confirmed success, failure, or interruption can resolve a wait and reach the graph's routing logic; unknown delivery is not an authored failure outcome.

A recorded headless launch whose runtime capture owner was lost is interrupted unless a result was already committed. A launch whose outcome was never recorded can remain uncertain. Neither interruption nor cancellation proves that external effects were rolled back or every process stopped. Arbitrary filesystem and process effects performed directly by author code remain the author's retry-safety responsibility.

On restart, unfinished runs are parked before graph dispatch begins. The runtime reconciles operations and waits against durable evidence, and continuation requires explicit Resume. A human gate still requires its own explicit answer.

## Controls and retention

Pause gates future execution while allowing an in-flight callback to reach its durable boundary. Already launched external work may continue. Resume lifts the gate under the existing code pin; Retry starts another attempt at a failed segment using verified code and the saved continuation; that attempt can fail again.

Cancel prevents further graph progression and requests best-effort cleanup of owned operations. History and late evidence remain available. Dismiss removes a finished or cancelled run's surface attachment without deleting its history. A surface holds at most one attached run, including a finished run until it is dismissed.

Run history also survives deletion of its surface or worktree. Retention preserves evidence, not a usable execution environment: a run cannot resume into a destination that no longer exists.

## Inspection and the client boundary

The workflow bar presents controls and human input and opens the read-only inspector. Declared shows the current pinned graph structure and execution position. Trace shows recorded executions across visits and code versions. Definition structure and actual execution history remain distinct.

The client derives its presentation from runtime-owned facts. Coherent snapshots and revision-ordered updates let it recover missed changes without treating arrival order as execution order. Inspection reads do not execute author callbacks or perform operational recovery.

The inspector is reached through an attached run's workflow bar. Retained history remains accessible through the run API after Dismiss, but there is currently no detached-run entry in the UI.

## Source entry points

- [Workflow SDK](../packages/workflow-sdk/src/index.ts): the public authoring contract.
- [Workflow verifier](../packages/workflow-verifier/): structural verification and build artifacts.
- [Runtime workflows](../apps/runtime/src/workflows/): loading, execution, operations, persistence, and read APIs.
- [Workflow contracts](../packages/contracts/src/workflows/): shared runtime/client wire shapes.
- [Client workflow state](../apps/web/src/lib/workspace/workflow/): synchronization and presentation state.
