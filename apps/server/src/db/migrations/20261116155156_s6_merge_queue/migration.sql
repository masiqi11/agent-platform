ALTER TABLE "merge_queue_item" ADD COLUMN "rebased_sha" text;--> statement-breakpoint
ALTER TABLE "merge_queue_item" ADD COLUMN "pipeline_id" text;--> statement-breakpoint
ALTER TABLE "merge_queue_item" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merge_queue_item" ADD COLUMN "merge_sha" text;--> statement-breakpoint
ALTER TABLE "merge_queue_item" ADD COLUMN "conflict_files" jsonb DEFAULT '[]' NOT NULL;