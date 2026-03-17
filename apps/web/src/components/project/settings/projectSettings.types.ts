export type GitMode =
  | "same_branch"
  | "managed_worktree"
  | "ask_each_time"
  | "global_default";

export type StatusBucket = "todo" | "in_progress" | "done";

export type EditableStatus = {
  readonly id: string;
  readonly bucket: StatusBucket;
  readonly name: string;
};
