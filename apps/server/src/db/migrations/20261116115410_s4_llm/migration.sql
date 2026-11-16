ALTER TABLE "model" ADD COLUMN "supports_streaming" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "model" ADD COLUMN "think_off" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_provider" ADD COLUMN "dialect" text DEFAULT 'openai' NOT NULL;