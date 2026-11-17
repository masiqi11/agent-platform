ALTER TABLE "binding" ADD COLUMN "chat_title" text;--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "settings" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "invalid_reason" text;--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "binding" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "outbound_delivery" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_delivery_binding_message_uq" ON "outbound_delivery" ("binding_id","message_id");--> statement-breakpoint
-- FR-IM-02 one-to-one: a platform group has at most one active binding per provider (hand-written).
CREATE UNIQUE INDEX binding_group_active_uq ON binding (provider, group_id) WHERE status = 'active';
--> statement-breakpoint
-- INV-20: unmapped IM accounts are "external" principals (no user, no membership) (hand-written).
ALTER TABLE principal DROP CONSTRAINT principal_kind_valid;
--> statement-breakpoint
ALTER TABLE principal ADD CONSTRAINT principal_kind_valid CHECK (kind IN ('human','agent','system','external'));
