PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pty_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pane_id` integer NOT NULL,
	`worktree_id` integer NOT NULL,
	`backend` text NOT NULL,
	`backend_ref_json` text NOT NULL,
	`purpose` text NOT NULL,
	`harness` text,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`exit_code` integer,
	`signal` text,
	`log_mode` text NOT NULL,
	`log_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`exited_at` text,
	`last_seen_at` text,
	FOREIGN KEY (`pane_id`) REFERENCES `surface_panes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pty_sessions`("id", "pane_id", "worktree_id", "backend", "backend_ref_json", "purpose", "harness", "command", "cwd", "status", "status_reason", "exit_code", "signal", "log_mode", "log_path", "created_at", "updated_at", "exited_at", "last_seen_at") SELECT "id", "pane_id", "worktree_id", "adapter", '{"schemaVersion":1,"backend":"node_pty","ptySessionId":' || "id" || ',"pid":null}', "purpose", "harness", "command", "cwd", "status", NULL, "exit_code", "signal", 'backend_file', "log_path", "created_at", "updated_at", "exited_at", NULL FROM `pty_sessions`;--> statement-breakpoint
DROP TABLE `pty_sessions`;--> statement-breakpoint
ALTER TABLE `__new_pty_sessions` RENAME TO `pty_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pty_sessions_pane_id_unique` ON `pty_sessions` (`pane_id`);
