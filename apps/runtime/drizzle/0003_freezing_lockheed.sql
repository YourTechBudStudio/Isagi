CREATE TABLE `pty_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pane_id` integer NOT NULL,
	`worktree_id` integer NOT NULL,
	`adapter` text NOT NULL,
	`purpose` text NOT NULL,
	`harness` text,
	`command` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`signal` text,
	`log_path` text NOT NULL,
	`log_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`exited_at` text,
	FOREIGN KEY (`pane_id`) REFERENCES `surface_panes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pty_sessions_pane_id_unique` ON `pty_sessions` (`pane_id`);--> statement-breakpoint
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
