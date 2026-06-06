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
CREATE TABLE `worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`path` text NOT NULL,
	`branch` text,
	`head` text,
	`is_root` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_project_path_unique` ON `worktrees` (`project_id`,`path`);