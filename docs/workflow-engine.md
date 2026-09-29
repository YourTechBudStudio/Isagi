# Workflow Subsystem

## Purpose and ownership

Workflows coordinate long-running agent work through declared graphs. Authors put the sequence, routing, and human gates in TypeScript; agents perform the work and supply judgments that the graph can act on.

The runtime owns execution, saved state, code versions, the record of external operations, and recovery. Author code uses the TypeScript SDK and Promise-based capabilities; the runtime manages operational lifecycles internally through Effect. The web client presents run state and sends explicit controls. A surface is where a run is shown; the run has its own durable identity.

This overview explains the subsystem's model and guarantees. Concrete authoring types, API shapes, persistence, and execution mechanics live in the code.

## Graphs and runs

A workflow parses its launch inputs into the parameters of a root graph. Graphs declare operations, checkpoints, nested graphs, routing edges, and completion outcomes. Each graph invocation owns private state; pure per-field reducers apply updates, and mappings pass parameters into children and completed outputs back to parents. Graph execution is sequential, with explicit waits for external work or human input.

Operations perform work and can complete immediately or return an explicit wait. Pure routing edges consume the resulting event and choose a declared destination. An exception in a node function, reducer, edge or mapping fails that execution; an agent reporting failure is an event the graph can handle through ordinary routing. A failed step changes no graph state.

Checkpoint nodes save declared files from the run's destination at a point in the graph. A checkpoint is self-contained: the Git `HEAD` commit at capture (none for a folder project or a repository with no commits) plus an exact copy of the scopes its plan names, stored in the runtime's content store. Nothing is inherited from earlier checkpoints, a missing scope path is recorded as missing, and no Git ref keeps the commit alive, so a squashed or discarded commit makes that checkpoint impossible to export. The saved checkpoint is part of its execution's result, so a Retry after a later failure reuses it instead of capturing again. A checkpoint does not save graph state, agent sessions, or other execution context; durable continuation remains part of the run.

The runtime exports a checkpoint in one call, which `isagi checkpoints export` makes: it creates a detached Isagi worktree at the recorded commit (or an empty folder when there is none) in a new directory outside every checkout, then makes each captured scope match its copy exactly. Export does not resume or launch a run; a failure after the directory was created leaves it in place.

One run contains the whole composed graph. A graph definition describes reusable structure, a graph invocation is one entry into a graph (the root once, and each subgraph visit once), and a node execution is one run of one node. A Retry is another execution that points at the one it retries. Repeated visits and retries keep distinct history under the same run.

Workflows are independently built and verified packages discovered from global, configured, and project sources. Higher-priority sources own matching workflow keys; a broken winning package does not silently fall back to another definition. Users can launch workflows through the command palette or the `isagi` CLI; both use the runtime's launch API.

Verification checks declared structure and produces the artifact the runtime loads. It does not prove that author routing is correct, loops terminate, or arbitrary author code is safe. Author callbacks run as trusted code inside the runtime.

## Durable continuation and code versions

Each node execution runs its node function once and saves what it returned before anything routes. That saved result is the only thing the runtime ever reuses. Everything after it is pure and always runs with the run's current code, in one transaction: the result's update through the reducers, the edge, and, when a graph reaches an outcome, its output, the parent's `onResult`, reducers and edge, and the next execution. A throwing step records its stage and the graph and node or outcome whose code threw, fails the execution being stepped, and writes nothing else. A `suspend`'s update is applied together with the edge once the wait is delivered, so a failed step can always be replayed on unchanged state.

Each execution records what the node returned, the event that came back, where the edge went, and the invocation's state afterwards, as a history of the run.

A run points at an immutable verified artifact. Resume and Retry both reload the latest verified build first, after checking that every open graph is still declared, that each subgraph link on the active path still enters the same graph, and that the parked node still exists with the same kind. A refused reload leaves the run unchanged. Authors remain responsible for the meaning and compatibility of saved state, events and outputs across edits. Each execution records the build that ran it.

## External work and recovery

Every side-effecting capability call (spawning an agent, sending a prompt, running a headless job, closing a pane) appends an operation to the run's log: the full request, what came back, and for agent turns the agent's reply, recorded when the turn is delivered. The log is history only. Nothing is reused from it, so a node function that runs again performs its effects again; authors keep each node to one side effect so a repeat is small and visible.

An agent-turn wait is answered by the latest turn in the session that started after the prompt was sent: a running turn keeps the wait open, an ended or failed one is delivered. The same rule applies to ordinary waiting, Resume and Retry (see ADR 0009), so a turn a person runs by hand after a failure is what a Retry picks up. A headless wait is delivered once every listed job has finished, with results in declared order.

Recovery that needs judgement is authored in the graph: a bounded self-retry route with a counter in state, or a human gate that asks a person to fix something and then routes back.

On restart, a node function that was running is marked interrupted and its run fails, so a person decides whether to Retry it. A run still preparing its environment fails the same way. Every other active run is paused; Resume re-checks its waits. Headless jobs that were running are interrupted and delivered to their edge as such on Resume. Neither interruption nor cancellation proves that external effects were rolled back.

## Controls and retention

Pause stops anything new from starting while an in-flight node function finishes and its result is saved; a person's answer is stored, but nothing routes until Resume. Resume reloads the latest build and continues. Retry, on a failed run, reloads the latest build and repeats the failed execution as a new execution: it reuses the saved result when there is one, and otherwise runs the node function again.

Cancel stops the run and stops its running headless processes on a best-effort basis; agent panes stay open and history remains. Dismiss detaches a completed, failed or cancelled run from its surface without deleting its history. A surface holds at most one attached run, including a finished run until it is dismissed.

Run history survives deletion of its surface or worktree. Every run belongs to the project it was launched in; that ownership is recorded when the run is created and never changes, so retained history stays attributable after its worktrees are gone. Retention preserves history, not a usable execution environment: a run cannot resume into a surface that no longer exists.

## Inspection and the client boundary

The workflow bar presents controls and human input and opens the read-only inspector. Declared shows the graph structure of the run's current build and its position. Trace shows recorded executions across visits, retries, pauses and code reloads. Checkpoints lists what each checkpoint saved and how to export it. A shared dock shows the selected execution's result, event, decision, state after the step, error, and its operations with the prompts sent and the replies recorded. Definition structure and actual execution history remain distinct.

Every change a run goes through appends to its event log, and each appended event is pushed live to clients together with the run's new summary. A client appends the event to its trace and refetches the run or execution the event names; the read routes are the source of truth and page by id. Inspection reads never run author code.

The inspector is reached through an attached run's workflow bar. Retained history remains accessible through the run API and `isagi` CLI after Dismiss, but there is currently no detached-run entry in the UI.

## Source entry points

- [Workflow SDK](../packages/workflow-sdk/src/index.ts): the public authoring contract.
- [Workflow verifier](../packages/workflow-verifier/): structural verification and build artifacts.
- [Runtime workflows](../apps/runtime/src/workflows/): loading, execution, operations, persistence, and read APIs.
- [Workflow contracts](../packages/contracts/src/workflows/): shared runtime/client wire shapes.
- [Client workflow state](../apps/web/src/lib/workspace/workflow/): synchronization and presentation state.
