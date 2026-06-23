CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_key` text NOT NULL,
	`worktree_id` integer,
	`surface_id` integer,
	`status` text NOT NULL,
	`wait_kind` text,
	`wait_condition` text,
	`resume_payload` text,
	`state_json` text NOT NULL,
	`state_version` integer NOT NULL,
	`owner` text,
	`ui_feedback` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_wait_kind_idx` ON `workflow_runs` (`status`,`wait_kind`);--> statement-breakpoint
CREATE INDEX `workflow_runs_worktree_idx` ON `workflow_runs` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_surface_idx` ON `workflow_runs` (`surface_id`);