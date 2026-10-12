# Runtime persistence

- Worktree-dependent state references `worktrees.id` with `onDelete: 'cascade'`, so deleting a worktree row removes its environment state.
- `state.json` holds only simple global resume pointers; durable worktree environment state belongs in the database.
