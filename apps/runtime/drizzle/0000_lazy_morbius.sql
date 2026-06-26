CREATE TABLE `agent_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`harness` text NOT NULL,
	`cwd` text NOT NULL,
	`active_pty_process_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
	`sort_order` integer NOT NULL,
	`session_kind` text,
	`session_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `terminal_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`cwd` text NOT NULL,
	`shell_command` text NOT NULL,
	`shell_args_json` text NOT NULL,
	`active_pty_process_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`active_pty_process_id`) REFERENCES `pty_processes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`state` text NOT NULL,
	`trigger` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_run_events_run_idx` ON `workflow_run_events` (`workflow_run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_key` text NOT NULL,
	`workflow_title` text NOT NULL,
	`worktree_id` integer,
	`surface_id` integer,
	`parent_run_id` integer,
	`root_run_id` integer,
	`status` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`wait_kind` text,
	`wait_condition` text,
	`resume_payload` text,
	`state_json` text NOT NULL,
	`state_version` integer NOT NULL,
	`owner` text,
	`error` text,
	`result_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`root_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_wait_kind_idx` ON `workflow_runs` (`status`,`wait_kind`);--> statement-breakpoint
CREATE INDEX `workflow_runs_paused_idx` ON `workflow_runs` (`paused`);--> statement-breakpoint
CREATE INDEX `workflow_runs_worktree_idx` ON `workflow_runs` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_surface_idx` ON `workflow_runs` (`surface_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_root_idx` ON `workflow_runs` (`root_run_id`);--> statement-breakpoint
CREATE TABLE `worktree_command_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worktree_id` integer NOT NULL,
	`command_name` text NOT NULL,
	`pty_process_id` integer,
	`status` text NOT NULL,
	`diagnostic_reason` text,
	`diagnostic_detail` text,
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
CREATE INDEX `worktree_command_states_active_pty_idx` ON `worktree_command_states` (`active_pty_process_id`);--> statement-breakpoint
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
	`output_excerpt` text,
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
	`title` text NOT NULL,
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