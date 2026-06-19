DROP INDEX `worktree_command_runs_log_path_idx`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` ADD `diagnostic_reason` text;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` ADD `diagnostic_detail` text;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `command_text`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `cwd`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `trigger`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `log_path`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `exit_code`;--> statement-breakpoint
ALTER TABLE `worktree_command_runs` DROP COLUMN `signal`;