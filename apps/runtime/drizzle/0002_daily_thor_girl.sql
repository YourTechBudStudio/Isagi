ALTER TABLE `projects` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `worktrees` ADD `sort_order` integer DEFAULT 0 NOT NULL;