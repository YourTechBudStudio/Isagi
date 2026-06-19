CREATE TABLE `worktree_command_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`command_name` text NOT NULL,
	`pty_process_id` integer,
	`command_text` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`trigger` text NOT NULL,
	`log_path` text,
	`exit_code` integer,
	`signal` text,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `worktree_command_runs_latest_idx` ON `worktree_command_runs` (`worktree_id`,`command_name`,`id`);--> statement-breakpoint
CREATE INDEX `worktree_command_runs_pty_idx` ON `worktree_command_runs` (`pty_process_id`);--> statement-breakpoint
CREATE INDEX `worktree_command_runs_log_path_idx` ON `worktree_command_runs` (`log_path`);--> statement-breakpoint
CREATE TABLE `worktree_command_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`command_name` text NOT NULL,
	`status` text NOT NULL,
	`active_pty_process_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_command_states_worktree_command_unique` ON `worktree_command_states` (`worktree_id`,`command_name`);--> statement-breakpoint
CREATE INDEX `worktree_command_states_active_pty_idx` ON `worktree_command_states` (`active_pty_process_id`);