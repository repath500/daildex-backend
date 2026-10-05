export type Migration = {
  id: string;
  sql: string;
};

export const migrations: Migration[] = [
  {
    id: "0001_email_first_core",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS citext;

      CREATE TABLE IF NOT EXISTS parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_uri TEXT UNIQUE,
        name TEXT NOT NULL,
        short_name TEXT,
        color_hex TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS constituencies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_uri TEXT UNIQUE,
        name TEXT NOT NULL,
        county TEXT,
        seat_count INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS representatives (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        representative_key TEXT NOT NULL UNIQUE,
        source_uri TEXT UNIQUE,
        source_member_code TEXT UNIQUE,
        name TEXT NOT NULL,
        chamber TEXT NOT NULL CHECK (chamber IN ('Dáil', 'Seanad')),
        role TEXT NOT NULL CHECK (role IN ('TD', 'Senator')),
        area TEXT NOT NULL,
        party_name TEXT NOT NULL,
        party_id UUID REFERENCES parties(id),
        constituency_id UUID REFERENCES constituencies(id),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'former')),
        first_elected_date DATE,
        raw_source JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS subscribers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email CITEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'unsubscribed', 'suppressed')),
        confirmed_at TIMESTAMPTZ,
        consent_version TEXT,
        token_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS subscription_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        representative_keys TEXT[] NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS subscriber_follows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        representative_id UUID NOT NULL REFERENCES representatives(id),
        event_types TEXT[] NOT NULL DEFAULT ARRAY['vote','debate','pq','news']::TEXT[],
        topic_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        alert_level TEXT NOT NULL DEFAULT 'important_only'
          CHECK (alert_level IN ('all', 'important_only')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (subscriber_id, representative_id)
      );

      CREATE TABLE IF NOT EXISTS consent_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        consent_version TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS request_rate_limits (
        bucket_key TEXT NOT NULL,
        window_started_at TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (bucket_key, window_started_at)
      );

      CREATE TABLE IF NOT EXISTS email_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind TEXT NOT NULL CHECK (kind IN ('confirm_subscription', 'alert', 'ai_reply')),
        recipient CITEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'processing', 'sent', 'failed', 'needs_review', 'cancelled')),
        idempotency_key TEXT NOT NULL UNIQUE,
        provider_message_id TEXT,
        locked_by TEXT,
        locked_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS ingest_checkpoints (
        source_type TEXT PRIMARY KEY,
        cursor_value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS ingest_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        records_seen INTEGER NOT NULL DEFAULT 0,
        records_written INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS raw_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type TEXT NOT NULL,
        source_external_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        raw_text TEXT,
        dedupe_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'processed', 'needs_review', 'rejected', 'failed')),
        locked_by TEXT,
        locked_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        UNIQUE (source_type, source_external_id)
      );

      CREATE TABLE IF NOT EXISTS raw_event_targets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_event_id UUID NOT NULL REFERENCES raw_events(id) ON DELETE CASCADE,
        representative_id UUID NOT NULL REFERENCES representatives(id),
        participation TEXT,
        match_confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'processed', 'needs_review', 'rejected', 'failed')),
        locked_by TEXT,
        locked_at TIMESTAMPTZ,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        UNIQUE (raw_event_id, representative_id)
      );

      CREATE TABLE IF NOT EXISTS alert_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_event_target_id UUID NOT NULL UNIQUE REFERENCES raw_event_targets(id),
        representative_id UUID NOT NULL REFERENCES representatives(id),
        event_type TEXT NOT NULL CHECK (event_type IN ('vote', 'debate', 'pq', 'news')),
        headline TEXT NOT NULL,
        summary TEXT NOT NULL,
        explanation TEXT NOT NULL,
        topic_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        source_url TEXT NOT NULL,
        source_label TEXT NOT NULL,
        importance_score DOUBLE PRECISION NOT NULL CHECK (importance_score >= 0 AND importance_score <= 1),
        confidence DOUBLE PRECISION CHECK (confidence >= 0 AND confidence <= 1),
        model_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL DEFAULT 'needs_review'
          CHECK (status IN ('draft', 'approved', 'needs_review', 'sent', 'rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_event_target_id UUID REFERENCES raw_event_targets(id),
        job_type TEXT NOT NULL CHECK (job_type IN ('alert_draft', 'email_reply')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rejected')),
        provider TEXT,
        model TEXT,
        prompt_version TEXT NOT NULL,
        response_payload JSONB,
        input_tokens INTEGER,
        output_tokens INTEGER,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS review_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        alert_item_id UUID NOT NULL REFERENCES alert_items(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('approved', 'rejected', 'edited')),
        actor TEXT NOT NULL,
        reason TEXT,
        revision JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS raw_events_pending_idx
        ON raw_events (status, fetched_at) WHERE status IN ('pending', 'failed');
      CREATE INDEX IF NOT EXISTS raw_event_targets_pending_idx
        ON raw_event_targets (status, id) WHERE status IN ('pending', 'failed');
      CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
        ON email_outbox (status, created_at) WHERE status IN ('queued', 'failed');
      CREATE INDEX IF NOT EXISTS subscriber_follows_representative_idx
        ON subscriber_follows (representative_id, alert_level);
      CREATE INDEX IF NOT EXISTS request_rate_limits_cleanup_idx
        ON request_rate_limits (window_started_at);
    `,
  },
  {
    id: "0002_email_threads_and_retrieval",
    sql: `
      ALTER TABLE email_outbox
        ADD COLUMN IF NOT EXISTS subscriber_id UUID REFERENCES subscribers(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS alert_item_id UUID REFERENCES alert_items(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS email_thread_id UUID;

      CREATE TABLE IF NOT EXISTS email_threads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        alert_item_id UUID NOT NULL REFERENCES alert_items(id) ON DELETE CASCADE,
        token_version INTEGER NOT NULL DEFAULT 1,
        provider_thread_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (subscriber_id, alert_item_id)
      );

      ALTER TABLE email_outbox
        ADD CONSTRAINT email_outbox_thread_fk
        FOREIGN KEY (email_thread_id) REFERENCES email_threads(id) ON DELETE CASCADE;

      CREATE TABLE IF NOT EXISTS email_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email_thread_id UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
        direction TEXT NOT NULL
          CHECK (direction IN ('outbound_alert', 'inbound_user', 'outbound_ai')),
        subject TEXT NOT NULL,
        body_text TEXT,
        body_html TEXT,
        provider_message_id TEXT,
        rfc_message_id TEXT,
        in_reply_to TEXT,
        references_header TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS email_messages_provider_id_idx
        ON email_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS email_messages_rfc_id_idx
        ON email_messages (rfc_message_id) WHERE rfc_message_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS email_delivery_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_event_id TEXT NOT NULL UNIQUE,
        provider_message_id TEXT,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS provider_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        event_type TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'needs_review')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at TIMESTAMPTZ,
        UNIQUE (provider, provider_event_id)
      );

      CREATE TABLE IF NOT EXISTS ai_replies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email_message_id UUID NOT NULL UNIQUE REFERENCES email_messages(id) ON DELETE CASCADE,
        subscriber_id UUID NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        question_type TEXT NOT NULL,
        answer TEXT,
        sources JSONB NOT NULL DEFAULT '[]'::JSONB,
        used_web_search BOOLEAN NOT NULL DEFAULT false,
        confidence DOUBLE PRECISION CHECK (confidence >= 0 AND confidence <= 1),
        model_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL DEFAULT 'needs_review'
          CHECK (status IN ('draft', 'sent', 'needs_review', 'rejected')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS td_facts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        representative_id UUID NOT NULL REFERENCES representatives(id),
        fact_type TEXT NOT NULL,
        fact_payload JSONB NOT NULL,
        source_url TEXT NOT NULL,
        source_event_id UUID REFERENCES raw_events(id),
        effective_at TIMESTAMPTZ,
        superseded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS policy_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        party_id UUID REFERENCES parties(id),
        source_type TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        full_text TEXT NOT NULL,
        published_at TIMESTAMPTZ,
        content_hash TEXT NOT NULL,
        last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_url, content_hash)
      );

      CREATE TABLE IF NOT EXISTS policy_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        policy_document_id UUID NOT NULL REFERENCES policy_documents(id) ON DELETE CASCADE,
        party_id UUID REFERENCES parties(id),
        topic_tag TEXT NOT NULL,
        chunk_text TEXT NOT NULL,
        source_page_ref TEXT,
        content_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (policy_document_id, content_hash)
      );

      CREATE INDEX IF NOT EXISTS email_threads_subscriber_idx ON email_threads (subscriber_id);
      CREATE INDEX IF NOT EXISTS provider_webhook_pending_idx
        ON provider_webhook_events (status, received_at) WHERE status IN ('pending', 'failed');
      CREATE INDEX IF NOT EXISTS td_facts_representative_idx
        ON td_facts (representative_id, effective_at DESC);
      CREATE INDEX IF NOT EXISTS policy_chunks_topic_idx ON policy_chunks (party_id, topic_tag);
    `,
  },
  {
    id: "0003_webhook_leases_and_reply_links",
    sql: `
      ALTER TABLE provider_webhook_events
        ADD COLUMN IF NOT EXISTS locked_by TEXT,
        ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

      ALTER TABLE email_outbox
        ADD COLUMN IF NOT EXISTS ai_reply_id UUID REFERENCES ai_replies(id) ON DELETE CASCADE;

      CREATE TABLE IF NOT EXISTS reply_review_actions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ai_reply_id UUID NOT NULL REFERENCES ai_replies(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK (action IN ('approved', 'rejected', 'edited')),
        actor TEXT NOT NULL,
        reason TEXT,
        revision JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS ai_replies_review_idx
        ON ai_replies (status, created_at) WHERE status IN ('draft', 'needs_review');
    `,
  },
  {
    id: "0004_reply_queue",
    sql: `
      ALTER TABLE ai_replies DROP CONSTRAINT IF EXISTS ai_replies_status_check;
      ALTER TABLE ai_replies ADD CONSTRAINT ai_replies_status_check
        CHECK (status IN ('pending', 'processing', 'draft', 'sent', 'needs_review', 'rejected', 'failed'));
      ALTER TABLE ai_replies
        ADD COLUMN IF NOT EXISTS locked_by TEXT,
        ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_error TEXT;

      ALTER TABLE agent_runs
        ADD COLUMN IF NOT EXISTS email_message_id UUID REFERENCES email_messages(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS ai_replies_pending_idx
        ON ai_replies (status, created_at) WHERE status IN ('pending', 'failed');
    `,
  },
  {
    id: "0005_privacy_lifecycle",
    sql: `
      CREATE TABLE IF NOT EXISTS suppression_tombstones (
        email_hash TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS privacy_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_hash TEXT NOT NULL,
        request_type TEXT NOT NULL CHECK (request_type IN ('export', 'erasure')),
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS privacy_requests_subject_idx
        ON privacy_requests (subject_hash, created_at DESC);
    `,
  },
  {
    id: "0006_runtime_controls",
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_controls (
        key TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT false,
        reason TEXT,
        updated_by TEXT NOT NULL DEFAULT 'migration',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO runtime_controls (key, enabled, reason)
      VALUES
        ('email_sending', false, 'Requires explicit launch enablement'),
        ('alert_generation', false, 'Requires explicit launch enablement'),
        ('reply_generation', false, 'Requires explicit launch enablement')
      ON CONFLICT (key) DO NOTHING;
    `,
  },
  {
    id: "0007_official_documents",
    sql: `
      CREATE TABLE IF NOT EXISTS official_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type TEXT NOT NULL CHECK (source_type IN ('oireachtas_question', 'oireachtas_debate')),
        source_uri TEXT NOT NULL,
        document_date DATE NOT NULL,
        title TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        xml_url TEXT,
        current_content_hash TEXT NOT NULL,
        last_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source_type, source_uri)
      );

      CREATE TABLE IF NOT EXISTS official_document_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        official_document_id UUID NOT NULL REFERENCES official_documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (official_document_id, content_hash)
      );

      CREATE TABLE IF NOT EXISTS official_contributions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        official_document_version_id UUID NOT NULL REFERENCES official_document_versions(id) ON DELETE CASCADE,
        representative_id UUID NOT NULL REFERENCES representatives(id),
        source_uri TEXT NOT NULL,
        section_id TEXT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        contribution_type TEXT NOT NULL CHECK (contribution_type IN ('question', 'speech')),
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        raw_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (official_document_version_id, source_uri, ordinal, representative_id)
      );

      ALTER TABLE raw_events
        ADD COLUMN IF NOT EXISTS official_document_id UUID REFERENCES official_documents(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS official_documents_date_idx
        ON official_documents (source_type, document_date DESC);
      CREATE INDEX IF NOT EXISTS official_contributions_representative_idx
        ON official_contributions (representative_id, created_at DESC);
    `,
  },
  {
    id: "0008_sourced_fact_dedupe",
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS td_facts_source_unique_idx
        ON td_facts (representative_id, fact_type, source_event_id)
        WHERE source_event_id IS NOT NULL;
    `,
  },
  {
    id: "0009_legislation_corpus",
    sql: `
      CREATE TABLE IF NOT EXISTS legislation_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_uri TEXT NOT NULL UNIQUE,
        bill_number TEXT NOT NULL,
        bill_year TEXT NOT NULL,
        title TEXT NOT NULL,
        long_title TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        current_stage TEXT,
        current_stage_date DATE,
        current_content_hash TEXT NOT NULL,
        last_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS legislation_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        legislation_document_id UUID NOT NULL REFERENCES legislation_documents(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        raw_payload JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (legislation_document_id, content_hash)
      );

      CREATE TABLE IF NOT EXISTS legislation_debate_links (
        legislation_document_id UUID NOT NULL REFERENCES legislation_documents(id) ON DELETE CASCADE,
        debate_uri TEXT NOT NULL,
        debate_section_id TEXT,
        debate_date DATE,
        label TEXT NOT NULL,
        PRIMARY KEY (legislation_document_id, debate_uri, debate_section_id)
      );

      CREATE TABLE IF NOT EXISTS legislation_related_documents (
        legislation_document_id UUID NOT NULL REFERENCES legislation_documents(id) ON DELETE CASCADE,
        source_uri TEXT NOT NULL,
        document_type TEXT NOT NULL,
        label TEXT NOT NULL,
        language TEXT,
        pdf_url TEXT,
        xml_url TEXT,
        PRIMARY KEY (legislation_document_id, source_uri)
      );

      CREATE INDEX IF NOT EXISTS legislation_stage_date_idx
        ON legislation_documents (current_stage_date DESC);
      CREATE INDEX IF NOT EXISTS legislation_debate_uri_idx
        ON legislation_debate_links (debate_uri);
    `,
  },
  {
    id: "0010_reviewed_policy_metadata",
    sql: `
      ALTER TABLE policy_documents
        ADD COLUMN IF NOT EXISTS source_owner TEXT,
        ADD COLUMN IF NOT EXISTS rights_basis TEXT,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS effective_date DATE;
      ALTER TABLE policy_chunks
        ADD COLUMN IF NOT EXISTS heading TEXT;
    `,
  },
  {
    id: "0011_dex_chat_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email CITEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 80),
        token_hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS chat_daily_usage (
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        usage_date DATE NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (profile_id, usage_date)
      );

      CREATE INDEX IF NOT EXISTS chat_daily_usage_cleanup_idx
        ON chat_daily_usage (usage_date);
    `,
  },
  {
    id: "0012_subscription_request_preferences",
    sql: `
      ALTER TABLE subscription_requests
        ADD COLUMN IF NOT EXISTS event_types TEXT[] NOT NULL
          DEFAULT ARRAY['vote','debate','pq','news']::TEXT[],
        ADD COLUMN IF NOT EXISTS topic_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        ADD COLUMN IF NOT EXISTS alert_level TEXT NOT NULL DEFAULT 'important_only';

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'subscription_requests_alert_level_check'
        ) THEN
          ALTER TABLE subscription_requests
            ADD CONSTRAINT subscription_requests_alert_level_check
            CHECK (alert_level IN ('all', 'important_only'));
        END IF;
      END $$;
    `,
  },
  {
    id: "0013_dex_cloud_training_consent",
    sql: `
      ALTER TABLE chat_profiles
        ADD COLUMN IF NOT EXISTS cloud_training_consent BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cloud_training_consent_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS chat_cloud_conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'New conversation',
        model_id TEXT NOT NULL,
        messages JSONB NOT NULL DEFAULT '[]'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (profile_id, conversation_id)
      );

      CREATE INDEX IF NOT EXISTS chat_cloud_conversations_profile_idx
        ON chat_cloud_conversations (profile_id, updated_at DESC);
    `,
  },
  {
    id: "0014_dex_promo_claims",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_promo_email_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email CITEXT NOT NULL,
        promo_code TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'blog',
        outcome TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS chat_promo_email_log_email_idx
        ON chat_promo_email_log (email, created_at DESC);

      CREATE TABLE IF NOT EXISTS chat_promo_claims (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email CITEXT NOT NULL,
        promo_code TEXT NOT NULL,
        multiplier INTEGER NOT NULL DEFAULT 2 CHECK (multiplier BETWEEN 1 AND 10),
        expires_at TIMESTAMPTZ NOT NULL,
        profile_id UUID REFERENCES chat_profiles(id) ON DELETE SET NULL,
        source TEXT NOT NULL DEFAULT 'blog',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (email, promo_code)
      );

      CREATE INDEX IF NOT EXISTS chat_promo_claims_active_idx
        ON chat_promo_claims (email, expires_at DESC);
    `,
  },
  {
    id: "0015_subscriber_locale",
    sql: `
      ALTER TABLE subscribers
        ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'subscribers_locale_check'
        ) THEN
          ALTER TABLE subscribers
            ADD CONSTRAINT subscribers_locale_check CHECK (locale IN ('en', 'ga'));
        END IF;
      END $$;
    `,
  },
  {
    id: "0016_alert_worker_hardening",
    sql: `
      ALTER TABLE agent_runs
        ADD COLUMN IF NOT EXISTS request_id TEXT,
        ADD COLUMN IF NOT EXISTS hermes_run_id TEXT,
        ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
        ADD COLUMN IF NOT EXISTS provider_verified BOOLEAN,
        ADD COLUMN IF NOT EXISTS error_class TEXT;

      CREATE INDEX IF NOT EXISTS raw_event_targets_processing_lease_idx
        ON raw_event_targets (status, locked_at, id)
        WHERE status = 'processing';

      CREATE INDEX IF NOT EXISTS agent_runs_target_started_idx
        ON agent_runs (raw_event_target_id, started_at DESC);
    `,
  },
  {
    id: "0017_chat_consent_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_consent_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        consent_type TEXT NOT NULL CHECK (consent_type IN ('cloud_training')),
        granted BOOLEAN NOT NULL,
        consent_version TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS chat_consent_events_profile_idx
        ON chat_consent_events (profile_id, created_at DESC);
    `,
  },
  {
    id: "0018_editorial_posts",
    sql: `
      CREATE TABLE IF NOT EXISTS editorial_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        constituency_name TEXT NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'published', 'suppressed', 'failed')),
        pass_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
        model_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ,
        UNIQUE (constituency_name, period_start, period_end)
      );

      CREATE TABLE IF NOT EXISTS editorial_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        editorial_run_id UUID NOT NULL UNIQUE REFERENCES editorial_runs(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE,
        constituency_name TEXT NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        content JSONB NOT NULL,
        source_urls JSONB NOT NULL DEFAULT '[]'::JSONB,
        verification JSONB NOT NULL DEFAULT '{}'::JSONB,
        model_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        status TEXT NOT NULL CHECK (status IN ('published', 'suppressed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS editorial_posts_published_idx
        ON editorial_posts (status, published_at DESC);
      CREATE INDEX IF NOT EXISTS editorial_runs_period_idx
        ON editorial_runs (period_start DESC, constituency_name);

      INSERT INTO runtime_controls (key, enabled, reason)
      VALUES ('editorial_generation', true, 'Enabled for the weekly /news loop')
      ON CONFLICT (key) DO NOTHING;
    `,
  },
  {
    id: "0019_national_news_stories",
    sql: `
      ALTER TABLE editorial_runs
        ADD COLUMN IF NOT EXISTS story_key TEXT,
        ADD COLUMN IF NOT EXISTS story_kind TEXT,
        ADD COLUMN IF NOT EXISTS story_origin TEXT,
        ADD COLUMN IF NOT EXISTS subject TEXT,
        ADD COLUMN IF NOT EXISTS normalized_subject TEXT,
        ADD COLUMN IF NOT EXISTS source_key TEXT;

      ALTER TABLE editorial_runs
        DROP CONSTRAINT IF EXISTS editorial_runs_constituency_name_period_start_period_end_key;

      CREATE UNIQUE INDEX IF NOT EXISTS editorial_runs_story_period_uidx
        ON editorial_runs (story_key, period_start, period_end);

      ALTER TABLE editorial_posts
        ADD COLUMN IF NOT EXISTS story_key TEXT,
        ADD COLUMN IF NOT EXISTS story_kind TEXT,
        ADD COLUMN IF NOT EXISTS story_origin TEXT,
        ADD COLUMN IF NOT EXISTS subject TEXT,
        ADD COLUMN IF NOT EXISTS normalized_subject TEXT,
        ADD COLUMN IF NOT EXISTS source_key TEXT;

      CREATE INDEX IF NOT EXISTS editorial_posts_subject_published_idx
        ON editorial_posts (normalized_subject, published_at DESC);
    `,
  },
  {
    id: "0020_dex_accounts_and_pro",
    sql: `
      ALTER TABLE chat_profiles
        ADD COLUMN IF NOT EXISTS auth_subject TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
        ADD COLUMN IF NOT EXISTS pro_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
        ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

      CREATE TABLE IF NOT EXISTS chat_billing_events (
        stripe_event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        profile_id UUID REFERENCES chat_profiles(id) ON DELETE SET NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0021_news_seo_fields",
    sql: `
      ALTER TABLE editorial_posts
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS participant_names JSONB NOT NULL DEFAULT '[]'::JSONB;

      UPDATE editorial_posts SET updated_at = published_at WHERE updated_at IS NULL;

      CREATE INDEX IF NOT EXISTS editorial_posts_participant_names_idx
        ON editorial_posts USING GIN (participant_names);

      UPDATE runtime_controls
        SET reason = 'Enabled for the daily /news loop'
        WHERE key = 'editorial_generation' AND reason = 'Enabled for the weekly /news loop';
    `,
  },
  {
    id: "0022_account_language",
    sql: `
      ALTER TABLE chat_profiles
        ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'auto'
          CHECK (preferred_language ~ '^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$');
    `,
  },
  {
    id: "0023_td_offices",
    sql: `
      ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_kind_check;
      ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
        CHECK (kind IN ('confirm_subscription', 'alert', 'ai_reply', 'td_office_login'));

      -- Oireachtas addresses that may open a TD's office dashboard. An address
      -- that matches the TD's own name is the owner and earns the public badge.
      CREATE TABLE IF NOT EXISTS td_office_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        representative_id UUID NOT NULL REFERENCES representatives(id) ON DELETE CASCADE,
        email CITEXT NOT NULL CHECK (email LIKE '%@oireachtas.ie'),
        role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
        session_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        verified_at TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_by UUID REFERENCES td_office_members(id) ON DELETE SET NULL,
        UNIQUE (representative_id, email)
      );

      CREATE INDEX IF NOT EXISTS td_office_members_rep_status_idx
        ON td_office_members (representative_id, status);

      CREATE TABLE IF NOT EXISTS td_office_login_tokens (
        token_hash TEXT PRIMARY KEY,
        member_id UUID NOT NULL REFERENCES td_office_members(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "0024_subscriber_acquisition",
    sql: `
      -- First-touch attribution (ref, source, campaign, entry path, referrer host).
      -- Set once when a subscriber first asks to follow; never overwritten.
      ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS acquisition JSONB;
      CREATE INDEX IF NOT EXISTS subscribers_acquisition_ref_idx
        ON subscribers ((acquisition ->> 'ref')) WHERE acquisition IS NOT NULL;
    `,
  },
  {
    id: "0025_dex_uploads_and_shared_tests",
    sql: `
      -- One row per distinct file a reader attaches to Dex. The rolling 7-day count
      -- of distinct fingerprints enforces the free weekly upload allowance.
      CREATE TABLE IF NOT EXISTS chat_upload_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chat_upload_events_profile_idx
        ON chat_upload_events (profile_id, created_at DESC);

      -- Practice tests a teacher or student chose to share by link. Holds the paper
      -- only (questions, answers, marking points); never a reader's answers or results.
      CREATE TABLE IF NOT EXISTS shared_tests (
        id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]{8,16}$'),
        profile_id UUID REFERENCES chat_profiles(id) ON DELETE SET NULL,
        content_hash TEXT NOT NULL,
        title TEXT NOT NULL,
        test JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
        view_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS shared_tests_profile_hash_uidx
        ON shared_tests (profile_id, content_hash) WHERE profile_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS shared_tests_expiry_idx ON shared_tests (expires_at);
    `,
  },
  {
    id: "0026_study_spaces",
    sql: `
      -- Dex Study spaces saved to a signed-in account so a learner can resume on any device.
      -- One JSONB document per space; revision gives optimistic concurrency between devices.
      CREATE TABLE IF NOT EXISTS study_spaces (
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        id UUID NOT NULL,
        title TEXT NOT NULL,
        data JSONB NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (profile_id, id)
      );
      CREATE INDEX IF NOT EXISTS study_spaces_profile_updated_idx
        ON study_spaces (profile_id, updated_at DESC);
    `,
  },
  {
    id: "0027_study_classes",
    sql: `
      -- Teacher class codes for Dex Study. A class pins a practice test (a snapshot, so results stay
      -- readable and markable after the share link expires) and collects scores students CHOOSE to send.
      CREATE TABLE IF NOT EXISTS study_classes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        -- 6 characters from an alphabet without I, L, O, 0 or 1; shown to people as ABC-DEF.
        code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
        shared_test_id TEXT REFERENCES shared_tests(id) ON DELETE SET NULL,
        test JSONB NOT NULL,
        -- Marks available per question, used to validate submitted per-question marks.
        question_maxes JSONB NOT NULL CHECK (jsonb_typeof(question_maxes) = 'array'),
        max_score INTEGER NOT NULL CHECK (max_score > 0),
        is_open BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '120 days')
      );
      CREATE INDEX IF NOT EXISTS study_classes_profile_created_idx
        ON study_classes (profile_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS study_classes_expiry_idx ON study_classes (expires_at);

      -- Only what a student chose to send: a display name they typed, marks, and (only if they ticked
      -- the box) their answers. No IP address, user agent or account identifier is stored.
      CREATE TABLE IF NOT EXISTS study_class_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        class_id UUID NOT NULL REFERENCES study_classes(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
        score INTEGER NOT NULL CHECK (score >= 0),
        max_score INTEGER NOT NULL CHECK (max_score > 0),
        question_marks JSONB NOT NULL CHECK (jsonb_typeof(question_marks) = 'array'),
        answers JSONB,
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (score <= max_score)
      );
      CREATE INDEX IF NOT EXISTS study_class_results_class_submitted_idx
        ON study_class_results (class_id, submitted_at DESC);
    `,
  },
  {
    id: "0028_editorial_revisions",
    sql: `
      ALTER TABLE editorial_posts ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS editorial_revision_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id UUID NOT NULL REFERENCES editorial_posts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('update', 'correction')),
        reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'needs_review', 'published', 'rejected', 'failed')),
        expected_updated_at TIMESTAMPTZ NOT NULL,
        lease_token UUID,
        locked_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        draft JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS editorial_revision_requests_active_idx
        ON editorial_revision_requests (post_id) WHERE status IN ('queued', 'running', 'needs_review');
      CREATE INDEX IF NOT EXISTS editorial_revision_requests_queue_idx
        ON editorial_revision_requests (status, created_at);
      CREATE TABLE IF NOT EXISTS editorial_post_revisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        request_id UUID NOT NULL UNIQUE REFERENCES editorial_revision_requests(id),
        post_id UUID NOT NULL REFERENCES editorial_posts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('update', 'correction')),
        note TEXT NOT NULL,
        reviewed_by TEXT NOT NULL,
        previous_content JSONB NOT NULL,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS editorial_post_revisions_post_idx
        ON editorial_post_revisions (post_id, created_at DESC);
    `,
  },
  {
    id: "0029_study_offers",
    sql: `
      -- Time-limited Study offers a signed-in account has claimed (e.g. the October 2026 higher-end models offer).
      CREATE TABLE IF NOT EXISTS study_offer_claims (
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        offer TEXT NOT NULL CHECK (offer ~ '^[a-z0-9-]{3,60}$'),
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (profile_id, offer)
      );

      -- Study requests made under an offer are counted here instead of the Dex daily message allowance,
      -- with a fair-use cap per account per UTC day.
      CREATE TABLE IF NOT EXISTS study_offer_usage (
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        offer TEXT NOT NULL,
        usage_date DATE NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (profile_id, offer, usage_date)
      );
      CREATE INDEX IF NOT EXISTS study_offer_usage_date_idx ON study_offer_usage (usage_date);
    `,
  },
  {
    id: "0030_public_api_platform",
    sql: `
      -- Public API platform: trigram search indexes (so substring search stops scanning whole tables),
      -- self-serve API keys, and webhook subscriptions with a delivery queue.
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE INDEX IF NOT EXISTS official_contributions_text_trgm_idx
        ON official_contributions USING gin (lower(text) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS official_documents_title_trgm_idx
        ON official_documents USING gin (lower(title) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS legislation_documents_text_trgm_idx
        ON legislation_documents USING gin (lower(title || ' ' || long_title || ' ' || coalesce(current_stage, '')) gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS raw_events_vote_text_trgm_idx
        ON raw_events USING gin (lower(coalesce(raw_text, '')) gin_trgm_ops)
        WHERE source_type = 'oireachtas_vote';
      CREATE INDEX IF NOT EXISTS raw_events_debate_section_idx
        ON raw_events (source_url) WHERE source_type = 'oireachtas_debate';
      CREATE INDEX IF NOT EXISTS raw_event_targets_representative_idx
        ON raw_event_targets (representative_id, raw_event_id);

      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        profile_id UUID NOT NULL REFERENCES chat_profiles(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
        -- First characters of the key, shown in the UI so people can tell keys apart. Not secret.
        prefix TEXT NOT NULL,
        -- HMAC of the key with the server pepper; the plaintext key is shown once and never stored.
        key_hash TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'partner')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS api_keys_profile_idx ON api_keys (profile_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS api_webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        url TEXT NOT NULL CHECK (char_length(url) <= 2000),
        events TEXT[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 4),
        representative_key TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS api_webhooks_key_idx ON api_webhooks (api_key_id);

      CREATE TABLE IF NOT EXISTS api_webhook_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        webhook_id UUID NOT NULL REFERENCES api_webhooks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        event_ref TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at TIMESTAMPTZ,
        UNIQUE (webhook_id, event_type, event_ref)
      );
      CREATE INDEX IF NOT EXISTS api_webhook_deliveries_due_idx
        ON api_webhook_deliveries (next_attempt_at) WHERE status = 'pending';

      -- Where the webhook scanner got to, per event type.
      CREATE TABLE IF NOT EXISTS api_webhook_checkpoints (
        event_type TEXT PRIMARY KEY,
        scanned_through TIMESTAMPTZ NOT NULL
      );
    `,
  },
  {
    id: "0031_student_deal_claims",
    sql: `
      -- One student deal (three months of Dex Pro at a student price) per person. Recorded when Stripe reports the
      -- checkout completed, keyed by the verified university address as well as the account so a second account
      -- on the same address can't claim again.
      CREATE TABLE IF NOT EXISTS student_deal_claims (
        profile_id UUID PRIMARY KEY REFERENCES chat_profiles(id) ON DELETE CASCADE,
        deal TEXT NOT NULL CHECK (deal ~ '^[a-z0-9-]{3,60}$'),
        email CITEXT NOT NULL,
        stripe_session_id TEXT,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS student_deal_claims_email_idx ON student_deal_claims (deal, email);
    `,
  },
  {
    id: "0032_student_deal_claim_holds",
    sql: `
      -- Claims now outlive the Dex profile (deleting a profile must not let the same address claim again), are
      -- counted per college mailbox rather than per exact string, and are held while a checkout is open so one
      -- person can't run several checkouts at once. The address is kept only as a hash.
      ALTER TABLE student_deal_claims DROP CONSTRAINT IF EXISTS student_deal_claims_profile_id_fkey;
      ALTER TABLE student_deal_claims DROP CONSTRAINT IF EXISTS student_deal_claims_pkey;
      ALTER TABLE student_deal_claims ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
      ALTER TABLE student_deal_claims ADD PRIMARY KEY (id);
      ALTER TABLE student_deal_claims ALTER COLUMN profile_id DROP NOT NULL;
      ALTER TABLE student_deal_claims
        ADD CONSTRAINT student_deal_claims_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES chat_profiles(id) ON DELETE SET NULL;
      ALTER TABLE student_deal_claims ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (status IN ('pending', 'claimed'));
      ALTER TABLE student_deal_claims ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
      ALTER TABLE student_deal_claims ADD COLUMN IF NOT EXISTS email_key TEXT;
      UPDATE student_deal_claims
        SET email_key = encode(sha256(convert_to(lower(email::TEXT), 'UTF8')), 'hex')
        WHERE email_key IS NULL;
      ALTER TABLE student_deal_claims ALTER COLUMN email_key SET NOT NULL;
      DROP INDEX IF EXISTS student_deal_claims_email_idx;
      ALTER TABLE student_deal_claims DROP COLUMN IF EXISTS email;
      CREATE UNIQUE INDEX IF NOT EXISTS student_deal_claims_key_idx ON student_deal_claims (deal, email_key);
      CREATE UNIQUE INDEX IF NOT EXISTS student_deal_claims_profile_idx
        ON student_deal_claims (deal, profile_id) WHERE profile_id IS NOT NULL;
    `,
  },
  {
    id: "0033_budget_live",
    sql: `
      -- Live updates on the Budget page. The worker drafts updates from sources it has read, and an
      -- editor can post one directly. Every update keeps its evidence; nothing is public until published.
      CREATE TABLE IF NOT EXISTS budget_live_updates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        budget TEXT NOT NULL CHECK (budget ~ '^[a-z0-9-]{3,40}$'),
        kind TEXT NOT NULL CHECK (kind IN ('update', 'measure', 'reaction', 'explainer', 'correction')),
        headline TEXT NOT NULL CHECK (char_length(headline) BETWEEN 8 AND 180),
        body TEXT NOT NULL CHECK (char_length(body) BETWEEN 20 AND 2000),
        sources JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
        origin TEXT NOT NULL CHECK (origin IN ('worker', 'editor')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
        pinned BOOLEAN NOT NULL DEFAULT false,
        fingerprint TEXT NOT NULL,
        model TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ,
        reviewed_by TEXT,
        reviewed_at TIMESTAMPTZ,
        UNIQUE (budget, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS budget_live_updates_feed_idx
        ON budget_live_updates (budget, status, published_at DESC);

      -- Anonymous poll votes: one per browser per poll. The browser id is stored only as a hash.
      CREATE TABLE IF NOT EXISTS budget_poll_votes (
        poll TEXT NOT NULL CHECK (poll ~ '^[a-z0-9-]{3,40}$'),
        voter_key TEXT NOT NULL CHECK (voter_key ~ '^[a-f0-9]{64}$'),
        option TEXT NOT NULL CHECK (option ~ '^[a-z0-9-]{2,40}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (poll, voter_key)
      );
      CREATE INDEX IF NOT EXISTS budget_poll_votes_option_idx ON budget_poll_votes (poll, option);

      INSERT INTO runtime_controls (key, enabled, reason)
      VALUES ('budget_live', false, 'Turn on for Budget day')
      ON CONFLICT (key) DO NOTHING;
    `,
  },
];
