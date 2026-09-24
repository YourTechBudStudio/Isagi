CREATE TABLE `workflow_checkpoint_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checkpoint_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`file_key` text,
	`content_ref` text,
	`byte_size` integer,
	`executable` integer,
	`scope_id` text,
	`scope_kind` text,
	`exclusions_json` text,
	`captured_by_checkpoint_key` text,
	`change_operation` text,
	`warning_reason` text,
	`warning_detail_json` text,
	`observed_by_checkpoint_key` text,
	FOREIGN KEY (`checkpoint_id`) REFERENCES `workflow_checkpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_checkpoint_entries_kind_shape" CHECK(CASE "workflow_checkpoint_entries"."kind"
        WHEN 'scope' THEN "workflow_checkpoint_entries"."path" IS NOT NULL AND "workflow_checkpoint_entries"."scope_id" IS NOT NULL AND "workflow_checkpoint_entries"."scope_kind" IS NOT NULL AND "workflow_checkpoint_entries"."exclusions_json" IS NOT NULL AND "workflow_checkpoint_entries"."captured_by_checkpoint_key" IS NOT NULL
        WHEN 'file' THEN "workflow_checkpoint_entries"."path" IS NOT NULL AND "workflow_checkpoint_entries"."file_key" IS NOT NULL AND "workflow_checkpoint_entries"."content_ref" IS NOT NULL AND "workflow_checkpoint_entries"."byte_size" IS NOT NULL AND "workflow_checkpoint_entries"."executable" IS NOT NULL
        WHEN 'absent' THEN "workflow_checkpoint_entries"."path" IS NOT NULL
        WHEN 'warning' THEN "workflow_checkpoint_entries"."warning_reason" IS NOT NULL AND "workflow_checkpoint_entries"."observed_by_checkpoint_key" IS NOT NULL
        WHEN 'change' THEN "workflow_checkpoint_entries"."path" IS NOT NULL AND "workflow_checkpoint_entries"."change_operation" IS NOT NULL AND ("workflow_checkpoint_entries"."change_operation" = 'delete' OR ("workflow_checkpoint_entries"."content_ref" IS NOT NULL AND "workflow_checkpoint_entries"."byte_size" IS NOT NULL AND "workflow_checkpoint_entries"."executable" IS NOT NULL))
        ELSE 0 END),
	CONSTRAINT "workflow_checkpoint_entries_file_key_files_only" CHECK("workflow_checkpoint_entries"."kind" = 'file' OR "workflow_checkpoint_entries"."file_key" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_checkpoint_entries_seq_unique` ON `workflow_checkpoint_entries` (`checkpoint_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_checkpoint_entries_file_key_unique` ON `workflow_checkpoint_entries` (`file_key`) WHERE "workflow_checkpoint_entries"."file_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_checkpoint_entries_kind_idx` ON `workflow_checkpoint_entries` (`checkpoint_id`,`kind`,`seq`);--> statement-breakpoint
CREATE TABLE `workflow_checkpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checkpoint_key` text NOT NULL,
	`run_id` integer NOT NULL,
	`frame_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`attempt_id` integer NOT NULL,
	`artifact_hash` text NOT NULL,
	`parent_checkpoint_id` integer,
	`node_id` text NOT NULL,
	`title` text NOT NULL,
	`base_kind` text NOT NULL,
	`base_reason` text,
	`base_commit_sha` text,
	`repository_project_id` integer NOT NULL,
	`repository_root_path` text NOT NULL,
	`scope_count` integer NOT NULL,
	`file_count` integer NOT NULL,
	`absent_count` integer NOT NULL,
	`warning_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_checkpoint_id`) REFERENCES `workflow_checkpoints`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_checkpoints_base_shape" CHECK(("workflow_checkpoints"."base_kind" = 'git' AND "workflow_checkpoints"."base_commit_sha" IS NOT NULL AND "workflow_checkpoints"."base_reason" IS NULL) OR ("workflow_checkpoints"."base_kind" = 'none' AND "workflow_checkpoints"."base_commit_sha" IS NULL AND "workflow_checkpoints"."base_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_checkpoints_key_unique` ON `workflow_checkpoints` (`checkpoint_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_checkpoints_execution_unique` ON `workflow_checkpoints` (`execution_id`);--> statement-breakpoint
CREATE INDEX `workflow_checkpoints_run_idx` ON `workflow_checkpoints` (`run_id`,`id`);