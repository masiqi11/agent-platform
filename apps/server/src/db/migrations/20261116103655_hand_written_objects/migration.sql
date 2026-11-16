-- 手写，勿被生成覆盖 (hand-written; drizzle-kit cannot express these objects, spec §8.3)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- INV-14: audit_log is append-only at the database level.
CREATE OR REPLACE FUNCTION audit_log_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (INV-14): % forbidden', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_forbid_change();
--> statement-breakpoint
-- Full-text (application-side tokenization, stored as 'simple' tsvector) + GIN
CREATE INDEX message_tokens_gin ON message USING gin (tokens);
--> statement-breakpoint
CREATE INDEX task_tokens_gin ON task USING gin (tokens);
--> statement-breakpoint
CREATE INDEX chunk_tokens_gin ON document_chunk USING gin (tokens);
--> statement-breakpoint
CREATE INDEX chunk_embedding_hnsw ON document_chunk USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
-- Partial unique indexes (INV-16 / §8.2 ★)
CREATE UNIQUE INDEX message_source_external_uq ON message (source, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX event_idempotency_uq ON event (idempotency_key) WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX job_dedupe_active_uq ON job (dedupe_key) WHERE status IN ('queued','running') AND dedupe_key IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX session_open_scope_uq ON session (agent_id, scope_type, scope_id) WHERE status NOT IN ('completed','failed');
--> statement-breakpoint
CREATE UNIQUE INDEX task_comment_external_uq ON task_comment (source, external_id) WHERE external_id IS NOT NULL;
--> statement-breakpoint
-- CHECK constraints
ALTER TABLE approval ADD CONSTRAINT approval_not_self CHECK (decided_by IS NULL OR decided_by <> requested_by);
--> statement-breakpoint
ALTER TABLE proposal ADD CONSTRAINT proposal_sources_nonempty CHECK (jsonb_typeof(source_message_ids) = 'array' AND jsonb_array_length(source_message_ids) > 0);
--> statement-breakpoint
ALTER TABLE project ADD CONSTRAINT project_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$');
--> statement-breakpoint
ALTER TABLE task ADD CONSTRAINT task_status_valid CHECK (status IN ('backlog','ready','in_progress','blocked','in_review','testing','done','cancelled'));
--> statement-breakpoint
ALTER TABLE task ADD CONSTRAINT task_priority_valid CHECK (priority IN ('P0','P1','P2','P3'));
--> statement-breakpoint
ALTER TABLE principal ADD CONSTRAINT principal_kind_valid CHECK (kind IN ('human','agent','system'));
--> statement-breakpoint
ALTER TABLE message ADD CONSTRAINT message_seq_positive CHECK (seq > 0);
