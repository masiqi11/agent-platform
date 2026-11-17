ALTER TABLE "agent" ADD COLUMN "engine" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider" ADD COLUMN "apis" jsonb DEFAULT '["chat"]' NOT NULL;