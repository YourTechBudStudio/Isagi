CREATE TABLE `workflow_run_preparations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`source` text NOT NULL,
	`request_json` text NOT NULL,
	`base_commit` text,
	`checkout_path` text,
	`worktree_receipt_json` text,
	`setup_receipt_json` text,
	`surface_receipt_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_preparations_run_unique` ON `workflow_run_preparations` (`run_id`);--> statement-breakpoint
ALTER TABLE `worktree_surfaces` ADD `creation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `worktree_surfaces_creation_key_unique` ON `worktree_surfaces` (`creation_key`);--> statement-breakpoint
--
-- Clean-state reset for story #44 (architecture §9.7 / program design §7.1).
--
-- Every run must have a preparation row, because the run summary's `preparation` field is not
-- nullable. Only developer databases exist, and a synthetic preparation row would record a
-- provenance nobody ever observed, so the honest migration is to drop the runs rather than invent
-- history for them. Cascades to frames, executions, attempts, transitions, transition changes,
-- attachments, operations, waits, pause intervals and version adoptions.
--
-- `workflow_artifacts` and `workflow_payloads` are deliberately left in place: they are
-- content-addressed retained records, not run state, and nothing about them is made inconsistent by
-- an absent run.
--
-- This statement is last in the file on purpose. It relies on ON DELETE CASCADE, which only fires
-- while `foreign_keys` is ON. A future generated migration that rebuilds a table will wrap that
-- rebuild in `PRAGMA foreign_keys=OFF` / `ON`; a delete landing inside that window would silently
-- orphan dependent rows instead of cascading them.
DELETE FROM `workflow_runs`;