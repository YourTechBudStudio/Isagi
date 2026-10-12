# Runtime persistence

- The SQLite driver is synchronous: `RuntimeDatabase` `use` and `transaction` callbacks never `yield*`, `await` or run an Effect. Fail a transaction with its typed `abort(error)`, not by throwing.
- Worktree-dependent state references `worktrees.id` with `onDelete: 'cascade'`, so deleting a worktree row removes its environment state.
- No composite primary keys: use an incremental integer key plus unique indexes for natural uniqueness (such as project and worktree paths).
- `state.json` holds only simple global resume pointers; durable worktree environment state belongs in the database.
- Git and the filesystem are the source of truth for repository and worktree facts where practical; persisted state is reconciled against them.
- Replacing a hand-written parser of persisted or user-authored data with a Schema must accept exactly the inputs the old parser did, proven by an equivalence test: a stricter decode silently resets users' state. A `Schema.Unknown` field that may be absent is `Schema.optionalKey(Schema.Unknown)`.
