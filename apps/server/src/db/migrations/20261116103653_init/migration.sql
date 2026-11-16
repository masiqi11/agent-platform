CREATE TABLE "agent" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"avatar" text,
	"model_policy" jsonb DEFAULT '{}' NOT NULL,
	"tool_allowlist" jsonb DEFAULT '[]' NOT NULL,
	"mcp_servers" jsonb DEFAULT '[]' NOT NULL,
	"sandbox_policy" jsonb DEFAULT '{}' NOT NULL,
	"budget" jsonb DEFAULT '{}' NOT NULL,
	"max_concurrency" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"auth_user_id" text UNIQUE,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"tenant_role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"session_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"head_sha" text,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"reject_to" text,
	"evidence" jsonb DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text,
	"session_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"uri" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"message_id" text,
	"group_id" text NOT NULL,
	"uri" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"mime" text NOT NULL,
	"scan_status" text DEFAULT 'unscanned' NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_anchor" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"exported_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"actor_principal_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"project_id" text,
	"before" jsonb,
	"after" jsonb,
	"policy" jsonb DEFAULT '{}' NOT NULL,
	"outcome" text NOT NULL,
	"trace_id" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bind_code" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"code_hash" text NOT NULL UNIQUE,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "binding" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_chat_id" text NOT NULL,
	"group_id" text NOT NULL,
	"mode" text DEFAULT 'at_only' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"period" text DEFAULT 'total' NOT NULL,
	"limit_tokens" integer,
	"limit_cost" numeric(14,6),
	"used_tokens" integer DEFAULT 0 NOT NULL,
	"used_cost" numeric(14,6) DEFAULT '0' NOT NULL,
	"reserved_cost" numeric(14,6) DEFAULT '0' NOT NULL,
	"reserved_tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_group" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"captain_agent_id" text,
	"visibility" text DEFAULT 'project' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_seq" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"last4" text NOT NULL,
	"project_ids" jsonb DEFAULT '[]' NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dead_letter" (
	"id" text PRIMARY KEY,
	"tenant_id" text,
	"source" text NOT NULL,
	"ref_id" text NOT NULL,
	"consumer" text,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replayed_at" timestamp with time zone,
	"discarded_by" text
);
--> statement-breakpoint
CREATE TABLE "decision" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"group_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source_message_ids" jsonb DEFAULT '[]' NOT NULL,
	"summary_id" text,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dep_edge" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"from_ref" text NOT NULL,
	"to_ref" text NOT NULL,
	"kind" text NOT NULL,
	"commit" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunk" (
	"id" text PRIMARY KEY,
	"index_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" text,
	"group_id" text,
	"source_kind" text NOT NULL,
	"path" text NOT NULL,
	"symbol" text,
	"commit" text NOT NULL,
	"start_line" integer DEFAULT 1 NOT NULL,
	"end_line" integer DEFAULT 1 NOT NULL,
	"text" text NOT NULL,
	"tokens" tsvector,
	"embedding" vector(768),
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalation" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"level" integer NOT NULL,
	"reason" text NOT NULL,
	"target_principal_id" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"next_escalation_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_question" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"question" text NOT NULL,
	"expected_refs" jsonb DEFAULT '[]' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"seq" bigserial UNIQUE,
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"actor_principal_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"trace_id" text NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_consumer" (
	"name" text PRIMARY KEY,
	"offset_seq" bigint DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identity" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_state" (
	"index_id" text,
	"path" text,
	"blob_sha" text NOT NULL,
	CONSTRAINT "file_state_pkey" PRIMARY KEY("index_id","path")
);
--> statement-breakpoint
CREATE TABLE "group_member" (
	"tenant_id" text NOT NULL,
	"group_id" text,
	"principal_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"notification_pref" text DEFAULT 'all' NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_member_pkey" PRIMARY KEY("group_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"actor_principal_id" text,
	"key" text,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"status_code" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_pkey" PRIMARY KEY("actor_principal_id","key")
);
--> statement-breakpoint
CREATE TABLE "inbox_item" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"group_key" text NOT NULL,
	"title" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"project_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"email" text,
	"tenant_role" text DEFAULT 'member' NOT NULL,
	"project_id" text,
	"project_role" text,
	"token_hash" text NOT NULL UNIQUE,
	"kind" text DEFAULT 'invite' NOT NULL,
	"target_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" text PRIMARY KEY,
	"tenant_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"dedupe_key" text,
	"concurrency_key" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_error" text,
	"cron" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_call" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text,
	"task_id" text,
	"session_id" text,
	"agent_id" text,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"provider_id" text,
	"prompt_version" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost" numeric(14,6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"fallback_from" text,
	"tool_mode" text,
	"repaired" boolean DEFAULT false NOT NULL,
	"used_fallback" boolean DEFAULT false NOT NULL,
	"data_classes" jsonb DEFAULT '[]' NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_scm_issue" (
	"id" text PRIMARY KEY,
	"repo_path" text NOT NULL,
	"iid" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'opened' NOT NULL,
	"labels" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_scm_mr" (
	"id" text PRIMARY KEY,
	"repo_path" text NOT NULL,
	"iid" integer NOT NULL,
	"source_branch" text NOT NULL,
	"target_branch" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'opened' NOT NULL,
	"merge_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_scm_note" (
	"id" text PRIMARY KEY,
	"repo_path" text NOT NULL,
	"target_type" text NOT NULL,
	"target_iid" integer NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_scm_pipeline" (
	"id" text PRIMARY KEY,
	"repo_path" text NOT NULL,
	"sha" text NOT NULL,
	"ref" text NOT NULL,
	"status" text NOT NULL,
	"log" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_entry" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text,
	"content" text NOT NULL,
	"source_ref" text,
	"written_by" text NOT NULL,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_queue_item" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL UNIQUE,
	"position" bigserial,
	"status" text DEFAULT 'queued' NOT NULL,
	"head_sha" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"thread_id" text,
	"seq" bigint NOT NULL,
	"author_principal_id" text NOT NULL,
	"author_label" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text NOT NULL,
	"blocks" jsonb,
	"mentions" jsonb DEFAULT '[]' NOT NULL,
	"reply_to_id" text,
	"source" text DEFAULT 'web' NOT NULL,
	"external_id" text,
	"wake_depth" integer DEFAULT 0 NOT NULL,
	"tokens" tsvector,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"corrected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_version" (
	"message_id" text,
	"version" integer,
	"body" text NOT NULL,
	"blocks" jsonb,
	"edited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_version_pkey" PRIMARY KEY("message_id","version")
);
--> statement-breakpoint
CREATE TABLE "model" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"context_window" integer DEFAULT 8192 NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_json" boolean DEFAULT false NOT NULL,
	"input_price" numeric(14,8),
	"output_price" numeric(14,8),
	"currency" text DEFAULT 'USD' NOT NULL,
	"embedding_dim" integer,
	"tier" text DEFAULT 'small' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_id" text,
	"kind" text NOT NULL,
	"is_external" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"circuit_state" jsonb DEFAULT '{"state":"closed","failures":0}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" text,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"owner_principal_id" text,
	"depends_on" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_delivery" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_index" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repo_id" text,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"commit" text,
	"embedding_model" text,
	"embedding_dim" integer,
	"tokenizer_version" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"stats" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_member" (
	"tenant_id" text NOT NULL,
	"project_id" text,
	"principal_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_member_pkey" PRIMARY KEY("project_id","principal_id")
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"group_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_message_ids" jsonb NOT NULL,
	"proposed_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"policy" text,
	"message_id" text,
	"result_task_ids" jsonb DEFAULT '[]' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"message_id" text,
	"text" text NOT NULL,
	"options" jsonb DEFAULT '[]' NOT NULL,
	"default_option" text,
	"irreversible" boolean DEFAULT false NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_record" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"mr_ref" text,
	"merge_commit" text NOT NULL,
	"test_run_id" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"credential_id" text,
	"webhook_secret_ref" text,
	"ca_cert_ref" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_indexed_commit" text,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"reviewer_principal_id" text NOT NULL,
	"reviewer_kind" text NOT NULL,
	"head_sha" text NOT NULL,
	"verdict" text NOT NULL,
	"comments" jsonb DEFAULT '[]' NOT NULL,
	"criteria_verdicts" jsonb DEFAULT '{}' NOT NULL,
	"round" integer NOT NULL,
	"superseded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sag2_cache" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"agent_config_version" integer NOT NULL,
	"summary" text,
	"checkpoint" jsonb DEFAULT '{}' NOT NULL,
	"last_event_seq" bigint DEFAULT 0 NOT NULL,
	"model" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_used" numeric(14,6) DEFAULT '0' NOT NULL,
	"stop_reason" text,
	"lease_owner" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_turn" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"idx" integer NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_calls" jsonb DEFAULT '[]' NOT NULL,
	"context_package" jsonb,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summary" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"version" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"content" jsonb NOT NULL,
	"supersedes_id" text,
	"corrected_by" text,
	"correction" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"group_id" text,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'feature' NOT NULL,
	"priority" text DEFAULT 'P2' NOT NULL,
	"status" text DEFAULT 'backlog' NOT NULL,
	"assignee_agent_id" text,
	"acceptance_criteria" jsonb DEFAULT '[]' NOT NULL,
	"test_plan" jsonb,
	"due_at" timestamp with time zone,
	"issue_ref" text,
	"issue_url" text,
	"source_message_ids" jsonb DEFAULT '[]' NOT NULL,
	"follow_up_of" text,
	"blocked_reason" text,
	"blocked_needs" text,
	"taken_over_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"rework_review_count" integer DEFAULT 0 NOT NULL,
	"rework_test_count" integer DEFAULT 0 NOT NULL,
	"tokens" tsvector,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comment" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"author_principal_id" text NOT NULL,
	"body" text NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_link" (
	"task_id" text,
	"other_task_id" text,
	"kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_link_pkey" PRIMARY KEY("task_id","other_task_id","kind")
);
--> statement-breakpoint
CREATE TABLE "task_owner" (
	"task_id" text,
	"principal_id" text,
	"role" text DEFAULT 'owner',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_owner_pkey" PRIMARY KEY("task_id","principal_id","role")
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"domain" text,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_run" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"tester_principal_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"plan" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"report_artifact_id" text,
	"log_artifact_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"criteria_results" jsonb DEFAULT '[]' NOT NULL,
	"superseded" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"group_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"root_message_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY,
	"tenant_id" text NOT NULL,
	"task_id" text NOT NULL,
	"repo_id" text NOT NULL,
	"branch" text NOT NULL,
	"base_commit" text,
	"head_commit" text,
	"worktree_path" text,
	"container_id" text,
	"worker_id" text,
	"mr_ref" text,
	"mr_url" text,
	"ci" jsonb,
	"diff_stat" jsonb,
	"status" text DEFAULT 'creating' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_project_idx" ON "agent" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_tenant_email_uq" ON "app_user" ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_tenant_seq_uq" ON "audit_log" ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_tenant_created_idx" ON "audit_log" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "binding_provider_chat_uq" ON "binding" ("provider","external_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_scope_uq" ON "budget" ("scope_type","scope_id","period");--> statement-breakpoint
CREATE INDEX "chunk_index_path_idx" ON "document_chunk" ("index_id","path");--> statement-breakpoint
CREATE INDEX "chunk_project_idx" ON "document_chunk" ("project_id");--> statement-breakpoint
CREATE INDEX "event_aggregate_idx" ON "event" ("tenant_id","aggregate_type","aggregate_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identity_uq" ON "external_identity" ("provider","external_user_id");--> statement-breakpoint
CREATE INDEX "inbox_principal_idx" ON "inbox_item" ("principal_id","read_at");--> statement-breakpoint
CREATE INDEX "job_status_run_idx" ON "job" ("status","run_at");--> statement-breakpoint
CREATE INDEX "llm_call_task_idx" ON "llm_call" ("task_id");--> statement-breakpoint
CREATE INDEX "llm_call_tenant_created_idx" ON "llm_call" ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_group_seq_uq" ON "message" ("group_id","seq");--> statement-breakpoint
CREATE INDEX "message_author_idx" ON "message" ("author_principal_id");--> statement-breakpoint
CREATE INDEX "principal_tenant_kind_idx" ON "principal" ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "principal_ref_idx" ON "principal" ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tenant_key_uq" ON "project" ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_project_number_uq" ON "task" ("project_id","number");--> statement-breakpoint
CREATE INDEX "task_project_status_priority_idx" ON "task" ("project_id","status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_task_repo_uq" ON "workspace" ("task_id","repo_id");--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_auth_user_id_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_group" ADD CONSTRAINT "chat_group_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "external_identity" ADD CONSTRAINT "external_identity_user_id_app_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_group_id_chat_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "chat_group"("id");--> statement-breakpoint
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_principal_id_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principal"("id");--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_group_id_chat_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "chat_group"("id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_principal_id_principal_id_fkey" FOREIGN KEY ("author_principal_id") REFERENCES "principal"("id");--> statement-breakpoint
ALTER TABLE "message_version" ADD CONSTRAINT "message_version_message_id_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "message"("id");--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_provider_id_model_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_provider"("id");--> statement-breakpoint
ALTER TABLE "module" ADD CONSTRAINT "module_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "principal" ADD CONSTRAINT "principal_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id");--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_principal_id_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principal"("id");--> statement-breakpoint
ALTER TABLE "repo" ADD CONSTRAINT "repo_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "session_turn" ADD CONSTRAINT "session_turn_session_id_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id");--> statement-breakpoint
ALTER TABLE "summary" ADD CONSTRAINT "summary_group_id_chat_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "chat_group"("id");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id");--> statement-breakpoint
ALTER TABLE "task_comment" ADD CONSTRAINT "task_comment_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "task_owner" ADD CONSTRAINT "task_owner_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "task_owner" ADD CONSTRAINT "task_owner_principal_id_principal_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principal"("id");--> statement-breakpoint
ALTER TABLE "test_run" ADD CONSTRAINT "test_run_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_group_id_chat_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "chat_group"("id");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_task_id_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id");--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_repo_id_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repo"("id");