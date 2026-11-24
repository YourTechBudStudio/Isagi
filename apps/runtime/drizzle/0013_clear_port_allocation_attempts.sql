-- Code Server now listens on a UNIX socket, so `port_allocation_failed` left the attempt vocabulary. A context that
-- failed for that reason has no pointer (only `previous_incarnation_not_stopped` may sit beside one), so it returns to
-- idle and its pane's next `reuse` launches a fresh incarnation.
UPDATE `editor_contexts` SET `attempt_state` = 'none', `attempt_reason` = NULL, `attempt_detail` = NULL, `attempt_started_at` = NULL WHERE `attempt_reason` = 'port_allocation_failed';
