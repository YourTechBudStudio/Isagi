CREATE TABLE `agent_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pane_id` integer NOT NULL,
	`worktree_id` integer NOT NULL,
	`harness` text NOT NULL,
	`cwd` text NOT NULL,
	`harness_session_id` text,
	`harness_session_ref_json` text,
	`active_pty_process_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`pane_id`) REFERENCES `surface_panes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_pane_id_unique` ON `agent_sessions` (`pane_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	`missing_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_root_path_unique` ON `projects` (`root_path`);--> statement-breakpoint
CREATE TABLE `pty_processes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`backend` text NOT NULL,
	`backend_ref_json` text NOT NULL,
	`command` text NOT NULL,
	`args_json` text NOT NULL,
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
	`last_seen_at` text
);
--> statement-breakpoint
CREATE TABLE `surface_panes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`surface_id` integer NOT NULL,
	`title` text NOT NULL,
	`attention` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pane_id` integer NOT NULL,
	`worktree_id` integer NOT NULL,
	`cwd` text NOT NULL,
	`shell_command` text NOT NULL,
	`shell_args_json` text NOT NULL,
	`active_pty_process_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pane_id`) REFERENCES `surface_panes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_sessions_pane_id_unique` ON `terminal_sessions` (`pane_id`);--> statement-breakpoint
CREATE TABLE `worktree_environment_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`active_surface_id` integer,
	`active_pane_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_pane_id`) REFERENCES `surface_panes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_environment_states_worktree_id_unique` ON `worktree_environment_states` (`worktree_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `worktree_setup_trust_project_scope_unique` ON `worktree_setup_trust` (`project_id`,`scope`);--> statement-breakpoint
CREATE TABLE `worktree_surfaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`attention` text NOT NULL,
	`layout_json` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`path` text NOT NULL,
	`branch` text,
	`head` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_project_path_unique` ON `worktrees` (`project_id`,`path`);