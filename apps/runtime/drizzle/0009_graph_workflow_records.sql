CREATE TABLE `workflow_artifacts` (
	`artifact_hash` text PRIMARY KEY NOT NULL,
	`workflow_key` text NOT NULL,
	`contract_version` integer NOT NULL,
	`manifest_version` integer NOT NULL,
	`descriptor_version` integer NOT NULL,
	`sdk_version` text NOT NULL,
	`verifier_version` text NOT NULL,
	`source_hash` text NOT NULL,
	`structure_hash` text NOT NULL,
	`root_graph_key` text NOT NULL,
	`descriptor_inline` text,
	`descriptor_ref` text,
	`first_seen_at` text NOT NULL,
	CONSTRAINT "workflow_artifacts_descriptor_slot" CHECK("workflow_artifacts"."descriptor_inline" IS NULL OR "workflow_artifacts"."descriptor_ref" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `workflow_artifacts_key_idx` ON `workflow_artifacts` (`workflow_key`,`first_seen_at`);--> statement-breakpoint
CREATE TABLE `workflow_graph_frames` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`parent_execution_id` integer,
	`graph_key` text NOT NULL,
	`entry_artifact_hash` text NOT NULL,
	`depth` integer NOT NULL,
	`status` text NOT NULL,
	`display_name` text,
	`parameters_inline` text,
	`parameters_ref` text,
	`state_inline` text,
	`state_ref` text,
	`outcome_id` text,
	`outcome_kind` text,
	`outcome_reason` text,
	`output_inline` text,
	`output_ref` text,
	`output_artifact_hash` text,
	`entered_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`output_artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_graph_frames_parameters_slot" CHECK("workflow_graph_frames"."parameters_inline" IS NULL OR "workflow_graph_frames"."parameters_ref" IS NULL),
	CONSTRAINT "workflow_graph_frames_state_slot" CHECK("workflow_graph_frames"."state_inline" IS NULL OR "workflow_graph_frames"."state_ref" IS NULL),
	CONSTRAINT "workflow_graph_frames_output_slot" CHECK("workflow_graph_frames"."output_inline" IS NULL OR "workflow_graph_frames"."output_ref" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `workflow_graph_frames_run_idx` ON `workflow_graph_frames` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_graph_frames_parent_idx` ON `workflow_graph_frames` (`parent_execution_id`);--> statement-breakpoint
CREATE TABLE `workflow_node_executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`frame_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`node_kind` text NOT NULL,
	`visit_index` integer NOT NULL,
	`status` text NOT NULL,
	`child_frame_id` integer,
	`display_name` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_certainty` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`child_frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_node_executions_frame_idx` ON `workflow_node_executions` (`frame_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_node_executions_run_idx` ON `workflow_node_executions` (`run_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_node_executions_visit_unique` ON `workflow_node_executions` (`frame_id`,`node_id`,`visit_index`);--> statement-breakpoint
CREATE TABLE `workflow_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_key` text NOT NULL,
	`run_id` integer NOT NULL,
	`frame_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`origin_attempt_id` integer NOT NULL,
	`capability` text NOT NULL,
	`call_index` integer NOT NULL,
	`request_fingerprint` text NOT NULL,
	`request_inline` text,
	`request_ref` text,
	`artifact_hash` text NOT NULL,
	`state` text NOT NULL,
	`stage` text,
	`receipt_inline` text,
	`receipt_ref` text,
	`result_inline` text,
	`result_ref` text,
	`target_kind` text NOT NULL,
	`target_id` integer,
	`pty_process_id` integer,
	`capture_owner` text,
	`attribution` text NOT NULL,
	`correlated_start_seq` integer,
	`correlated_harness_session_id` text,
	`submission_watermark` text,
	`stop_state` text NOT NULL,
	`stop_detail` text,
	`stop_requested_at` text,
	`stop_settled_at` text,
	`uncertainty_detail` text,
	`late_evidence_inline` text,
	`late_evidence_ref` text,
	`created_at` text NOT NULL,
	`dispatched_at` text,
	`settled_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_operations_request_slot" CHECK("workflow_operations"."request_inline" IS NULL OR "workflow_operations"."request_ref" IS NULL),
	CONSTRAINT "workflow_operations_receipt_slot" CHECK("workflow_operations"."receipt_inline" IS NULL OR "workflow_operations"."receipt_ref" IS NULL),
	CONSTRAINT "workflow_operations_result_slot" CHECK("workflow_operations"."result_inline" IS NULL OR "workflow_operations"."result_ref" IS NULL),
	CONSTRAINT "workflow_operations_late_evidence_slot" CHECK("workflow_operations"."late_evidence_inline" IS NULL OR "workflow_operations"."late_evidence_ref" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_operations_key_unique` ON `workflow_operations` (`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_operations_call_position_unique` ON `workflow_operations` (`execution_id`,`call_index`);--> statement-breakpoint
CREATE INDEX `workflow_operations_run_state_idx` ON `workflow_operations` (`run_id`,`state`);--> statement-breakpoint
CREATE INDEX `workflow_operations_capture_owner_idx` ON `workflow_operations` (`capture_owner`,`state`);--> statement-breakpoint
CREATE INDEX `workflow_operations_target_idx` ON `workflow_operations` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE INDEX `workflow_operations_pty_idx` ON `workflow_operations` (`pty_process_id`);--> statement-breakpoint
CREATE TABLE `workflow_pause_intervals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`reason` text NOT NULL,
	`paused_at` text NOT NULL,
	`resumed_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_pause_intervals_run_idx` ON `workflow_pause_intervals` (`run_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_pause_intervals_open_unique` ON `workflow_pause_intervals` (`run_id`) WHERE "workflow_pause_intervals"."resumed_at" IS NULL;--> statement-breakpoint
CREATE TABLE `workflow_payloads` (
	`payload_ref` text PRIMARY KEY NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_run_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`worktree_id` integer NOT NULL,
	`surface_id` integer,
	`attached_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`surface_id`) REFERENCES `worktree_surfaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_attachments_run_unique` ON `workflow_run_attachments` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_run_attachments_surface_unique` ON `workflow_run_attachments` (`surface_id`) WHERE "workflow_run_attachments"."surface_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_run_attachments_worktree_idx` ON `workflow_run_attachments` (`worktree_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_key` text NOT NULL,
	`title` text NOT NULL,
	`root_graph_key` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`status` text NOT NULL,
	`outcome_id` text,
	`outcome_kind` text,
	`output_inline` text,
	`output_ref` text,
	`position_json` text NOT NULL,
	`active_frame_id` integer,
	`paused` integer DEFAULT false NOT NULL,
	`environment_available` integer DEFAULT true NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`control_revision` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`active_attempt_id` integer,
	`pending_invocation_kind` text,
	`owner` text,
	`owner_incarnation` text,
	`failure_code` text,
	`failure_message` text,
	`failure_attempt_id` integer,
	`blocked_operation_id` integer,
	`origin_worktree_id` integer,
	`origin_worktree_path` text,
	`origin_surface_id` integer,
	`origin_pane_id` integer,
	`origin_agent_session_id` integer,
	`destination_worktree_id` integer,
	`destination_worktree_path` text,
	`destination_surface_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`active_attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`failure_attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`blocked_operation_id`) REFERENCES `workflow_operations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workflow_runs_output_slot" CHECK("workflow_runs"."output_inline" IS NULL OR "workflow_runs"."output_ref" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_dispatch_idx` ON `workflow_runs` (`status`,`paused`);--> statement-breakpoint
CREATE INDEX `workflow_runs_key_idx` ON `workflow_runs` (`workflow_key`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_created_idx` ON `workflow_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_revision_idx` ON `workflow_runs` (`revision`);--> statement-breakpoint
CREATE INDEX `workflow_runs_destination_worktree_idx` ON `workflow_runs` (`destination_worktree_id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_destination_surface_idx` ON `workflow_runs` (`destination_surface_id`);--> statement-breakpoint
CREATE TABLE `workflow_segment_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`frame_id` integer NOT NULL,
	`execution_id` integer,
	`segment_kind` text NOT NULL,
	`segment_ref` text,
	`attempt_index` integer NOT NULL,
	`artifact_hash` text NOT NULL,
	`status` text NOT NULL,
	`invocation_kind` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`end_certainty` text NOT NULL,
	`failure_code` text,
	`failure_message` text,
	`input_inline` text,
	`input_ref` text,
	`producer_output_inline` text,
	`producer_output_ref` text,
	`producer_artifact_hash` text,
	`failure_detail_inline` text,
	`failure_detail_ref` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`producer_artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_segment_attempts_input_slot" CHECK("workflow_segment_attempts"."input_inline" IS NULL OR "workflow_segment_attempts"."input_ref" IS NULL),
	CONSTRAINT "workflow_segment_attempts_producer_slot" CHECK("workflow_segment_attempts"."producer_output_inline" IS NULL OR "workflow_segment_attempts"."producer_output_ref" IS NULL),
	CONSTRAINT "workflow_segment_attempts_failure_detail_slot" CHECK("workflow_segment_attempts"."failure_detail_inline" IS NULL OR "workflow_segment_attempts"."failure_detail_ref" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `workflow_segment_attempts_execution_idx` ON `workflow_segment_attempts` (`execution_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_segment_attempts_run_idx` ON `workflow_segment_attempts` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_segment_attempts_segment_idx` ON `workflow_segment_attempts` (`frame_id`,`segment_kind`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`recorded_at` text NOT NULL,
	`kind` text NOT NULL,
	`frame_id` integer,
	`execution_id` integer,
	`attempt_id` integer,
	`operation_id` integer,
	`wait_id` integer,
	`artifact_hash` text,
	`state_inline` text,
	`state_ref` text,
	`detail_inline` text,
	`detail_ref` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frame_id`) REFERENCES `workflow_graph_frames`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `workflow_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wait_id`) REFERENCES `workflow_waits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workflow_transitions_state_slot" CHECK("workflow_transitions"."state_inline" IS NULL OR "workflow_transitions"."state_ref" IS NULL),
	CONSTRAINT "workflow_transitions_detail_slot" CHECK("workflow_transitions"."detail_inline" IS NULL OR "workflow_transitions"."detail_ref" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_transitions_revision_unique` ON `workflow_transitions` (`run_id`,`revision`);--> statement-breakpoint
CREATE INDEX `workflow_transitions_run_idx` ON `workflow_transitions` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_version_adoptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`artifact_hash` text NOT NULL,
	`reason` text NOT NULL,
	`attempt_id` integer,
	`adopted_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_hash`) REFERENCES `workflow_artifacts`(`artifact_hash`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `workflow_segment_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_version_adoptions_run_idx` ON `workflow_version_adoptions` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_waits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`execution_id` integer NOT NULL,
	`wait_kind` text NOT NULL,
	`condition_inline` text,
	`condition_ref` text,
	`status` text NOT NULL,
	`armed_at` text NOT NULL,
	`delivered_at` text,
	`consumed_at` text,
	`event_inline` text,
	`event_ref` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`execution_id`) REFERENCES `workflow_node_executions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_waits_condition_slot" CHECK("workflow_waits"."condition_inline" IS NULL OR "workflow_waits"."condition_ref" IS NULL),
	CONSTRAINT "workflow_waits_event_slot" CHECK("workflow_waits"."event_inline" IS NULL OR "workflow_waits"."event_ref" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `workflow_waits_run_status_idx` ON `workflow_waits` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_waits_execution_idx` ON `workflow_waits` (`execution_id`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `creation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_creation_key_unique` ON `agent_sessions` (`creation_key`);--> statement-breakpoint
ALTER TABLE `surface_panes` ADD `creation_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `surface_panes_creation_key_unique` ON `surface_panes` (`creation_key`);