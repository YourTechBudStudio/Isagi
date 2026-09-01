CREATE TABLE `editor_contexts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`active_pty_process_id` integer,
	`endpoint_host` text,
	`endpoint_port` integer,
	`session_socket_path` text,
	`attempt_state` text NOT NULL,
	`attempt_reason` text,
	`attempt_detail` text,
	`attempt_started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `editor_contexts_worktree_id_unique` ON `editor_contexts` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `editor_contexts_active_pty_idx` ON `editor_contexts` (`active_pty_process_id`);