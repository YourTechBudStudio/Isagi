CREATE TABLE `worktree_setup_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`lifecycle` text NOT NULL,
	`hook_config_hash` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `worktree_setup_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`hook_index` integer NOT NULL,
	`hook_type` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`message` text,
	`command` text,
	`src` text,
	`dest` text,
	`exit_code` integer,
	`signal` text,
	`stdout_excerpt` text,
	`stderr_excerpt` text,
	FOREIGN KEY (`run_id`) REFERENCES `worktree_setup_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `worktree_setup_trust` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`scope` text NOT NULL,
	`trusted_hash` text,
	`always_trust_project` integer NOT NULL,
	`hooks_disabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_setup_trust_project_scope_unique` ON `worktree_setup_trust` (`project_id`,`scope`);