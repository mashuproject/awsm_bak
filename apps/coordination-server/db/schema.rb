# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_07_19_000000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "pgcrypto"

  create_table "account_sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.datetime "confirmed_at", null: false
    t.datetime "created_at", null: false
    t.datetime "revoked_at"
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_account_sessions_on_account_id"
  end

  create_table "accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_key_id", null: false
    t.string "authentication_secret_digest", null: false
    t.datetime "created_at", null: false
    t.string "email", null: false
    t.bigint "kdf_memory_bytes", default: 67108864, null: false
    t.integer "kdf_operations", default: 3, null: false
    t.binary "kdf_salt", null: false
    t.string "key_envelope_algorithm", default: "wrap:xchacha20poly1305:account-password:v1", null: false
    t.binary "key_envelope_ciphertext", null: false
    t.binary "key_envelope_nonce", null: false
    t.datetime "updated_at", null: false
    t.index ["account_key_id"], name: "index_accounts_on_account_key_id", unique: true
    t.index ["email"], name: "index_accounts_on_email", unique: true
    t.check_constraint "email::text = lower(email::text)", name: "accounts_normalized_email"
    t.check_constraint "kdf_memory_bytes = 67108864", name: "accounts_kdf_memory"
    t.check_constraint "kdf_operations = 3", name: "accounts_kdf_operations"
    t.check_constraint "octet_length(kdf_salt) = 16", name: "accounts_kdf_salt"
    t.check_constraint "octet_length(key_envelope_ciphertext) >= 48", name: "accounts_key_envelope_ciphertext"
    t.check_constraint "octet_length(key_envelope_nonce) = 24", name: "accounts_key_envelope_nonce"
  end

  create_table "delivery_changes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "accepted_at", null: false
    t.datetime "created_at", null: false
    t.bigint "cursor", null: false
    t.uuid "event_commit_id"
    t.string "kind", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["event_commit_id"], name: "index_delivery_changes_on_event_commit_id"
    t.index ["vault_generation_id"], name: "index_delivery_changes_on_vault_generation_id"
    t.index ["vault_replica_id", "cursor"], name: "index_delivery_changes_on_vault_replica_id_and_cursor", unique: true
    t.index ["vault_replica_id"], name: "index_delivery_changes_on_vault_replica_id"
    t.check_constraint "cursor > 0", name: "delivery_changes_cursor"
    t.check_constraint "kind::text = ANY (ARRAY['EventCommitted'::character varying::text, 'GenerationActivated'::character varying::text])", name: "delivery_changes_kind"
  end

  create_table "event_commits", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "committed_at", null: false
    t.datetime "created_at", null: false
    t.bigint "cursor", null: false
    t.uuid "event_record_id", null: false
    t.binary "request_sha256", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["event_record_id"], name: "index_event_commits_on_event_record_id", unique: true
    t.index ["vault_generation_id"], name: "index_event_commits_on_vault_generation_id"
    t.index ["vault_replica_id", "cursor"], name: "index_event_commits_on_vault_replica_id_and_cursor", unique: true
    t.index ["vault_replica_id"], name: "index_event_commits_on_vault_replica_id"
    t.check_constraint "cursor > 0", name: "event_commits_cursor"
    t.check_constraint "octet_length(request_sha256) = 32", name: "event_commits_request_sha256"
  end

  create_table "generation_memberships", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.uuid "opaque_record_id", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.index ["opaque_record_id"], name: "index_generation_memberships_on_opaque_record_id"
    t.index ["vault_generation_id", "opaque_record_id"], name: "index_generation_memberships_on_generation_and_record", unique: true
    t.index ["vault_generation_id"], name: "index_generation_memberships_on_vault_generation_id"
  end

  create_table "generation_reachability_entries", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.uuid "generation_reachability_page_id", null: false
    t.uuid "opaque_record_id", null: false
    t.integer "ordinal", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.index ["generation_reachability_page_id", "ordinal"], name: "index_reachability_entries_on_page_and_ordinal", unique: true
    t.index ["generation_reachability_page_id"], name: "idx_on_generation_reachability_page_id_f20536e9ff"
    t.index ["opaque_record_id"], name: "index_generation_reachability_entries_on_opaque_record_id"
    t.index ["vault_generation_id", "opaque_record_id"], name: "index_reachability_entries_on_generation_and_record", unique: true
    t.index ["vault_generation_id"], name: "index_generation_reachability_entries_on_vault_generation_id"
    t.check_constraint "ordinal >= 0", name: "generation_reachability_entries_ordinal"
  end

  create_table "generation_reachability_pages", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "accepted_at", null: false
    t.datetime "created_at", null: false
    t.integer "entry_count", null: false
    t.integer "page_number", null: false
    t.binary "sha256", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.index ["vault_generation_id", "page_number"], name: "index_reachability_pages_on_generation_and_number", unique: true
    t.index ["vault_generation_id"], name: "index_generation_reachability_pages_on_vault_generation_id"
    t.check_constraint "entry_count >= 0", name: "generation_reachability_pages_count"
    t.check_constraint "octet_length(sha256) = 32", name: "generation_reachability_pages_sha256"
    t.check_constraint "page_number >= 0", name: "generation_reachability_pages_number"
  end

  create_table "idempotency_records", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.string "canonical_path", null: false
    t.datetime "created_at", null: false
    t.string "http_method", null: false
    t.uuid "idempotency_key", null: false
    t.string "operation", null: false
    t.binary "request_sha256", null: false
    t.uuid "resource_id"
    t.string "resource_type"
    t.string "status", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id", "operation", "idempotency_key"], name: "index_idempotency_records_on_account_operation_key", unique: true
    t.index ["account_id"], name: "index_idempotency_records_on_account_id"
    t.check_constraint "octet_length(request_sha256) = 32", name: "idempotency_records_request_sha256"
    t.check_constraint "status::text = ANY (ARRAY['InProgress'::character varying::text, 'Succeeded'::character varying::text])", name: "idempotency_records_status"
  end

  create_table "opaque_records", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.bigint "byte_length", null: false
    t.datetime "committed_at"
    t.datetime "created_at", null: false
    t.datetime "durable_at"
    t.datetime "event_ordering_timestamp"
    t.uuid "object_id", null: false
    t.string "object_type", null: false
    t.datetime "purged_at"
    t.binary "sha256", null: false
    t.string "state", null: false
    t.string "storage_key"
    t.uuid "target_generation_id", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["object_id"], name: "index_opaque_records_on_object_id", unique: true
    t.index ["vault_replica_id", "state"], name: "index_opaque_records_on_vault_replica_id_and_state"
    t.index ["vault_replica_id", "target_generation_id"], name: "idx_on_vault_replica_id_target_generation_id_ff5b12380a"
    t.index ["vault_replica_id"], name: "index_opaque_records_on_vault_replica_id"
    t.check_constraint "byte_length > 0", name: "opaque_records_byte_length"
    t.check_constraint "object_type::text = 'Event'::text AND event_ordering_timestamp IS NOT NULL OR object_type::text <> 'Event'::text AND event_ordering_timestamp IS NULL", name: "opaque_records_event_metadata"
    t.check_constraint "object_type::text = ANY (ARRAY['Event'::character varying::text, 'BundleDescriptor'::character varying::text, 'Artifact'::character varying::text, 'VaultGeneration'::character varying::text])", name: "opaque_records_type"
    t.check_constraint "octet_length(sha256) = 32", name: "opaque_records_sha256"
    t.check_constraint "state::text = ANY (ARRAY['Uploading'::character varying::text, 'DurableUncommitted'::character varying::text, 'Committed'::character varying::text, 'Purged'::character varying::text])", name: "opaque_records_state"
  end

  create_table "purge_job_generations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.uuid "purge_job_id", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_generation_id", null: false
    t.index ["purge_job_id", "vault_generation_id"], name: "index_purge_job_generations_on_job_and_generation", unique: true
    t.index ["purge_job_id"], name: "index_purge_job_generations_on_purge_job_id"
    t.index ["vault_generation_id"], name: "index_purge_job_generations_on_vault_generation_id"
  end

  create_table "purge_jobs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "completed_at"
    t.datetime "confirmed_at"
    t.datetime "created_at", null: false
    t.string "error_outcome"
    t.bigint "generation_count", default: 0, null: false
    t.bigint "processed_bytes", default: 0, null: false
    t.string "reason", null: false
    t.bigint "record_count", default: 0, null: false
    t.integer "retry_count", default: 0, null: false
    t.string "stage", null: false
    t.datetime "started_at"
    t.string "state", null: false
    t.bigint "total_bytes", default: 0, null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["vault_replica_id"], name: "index_one_active_purge_per_vault", unique: true, where: "((state)::text = ANY (ARRAY[('Pending'::character varying)::text, ('Running'::character varying)::text, ('FailedRetryable'::character varying)::text]))"
    t.index ["vault_replica_id"], name: "index_purge_jobs_on_vault_replica_id"
    t.check_constraint "generation_count >= 0 AND record_count >= 0 AND processed_bytes >= 0 AND total_bytes >= 0 AND retry_count >= 0", name: "purge_jobs_counters"
    t.check_constraint "reason::text = ANY (ARRAY['Automatic'::character varying::text, 'Manual'::character varying::text])", name: "purge_jobs_reason"
    t.check_constraint "stage::text = ANY (ARRAY['Snapshot'::character varying::text, 'Detach'::character varying::text, 'Analyze'::character varying::text, 'DeleteBytes'::character varying::text, 'Tombstone'::character varying::text, 'Complete'::character varying::text])", name: "purge_jobs_stage"
    t.check_constraint "state::text = ANY (ARRAY['Pending'::character varying::text, 'Running'::character varying::text, 'Succeeded'::character varying::text, 'FailedRetryable'::character varying::text])", name: "purge_jobs_state"
  end

  create_table "record_dependencies", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.uuid "dependency_record_id", null: false
    t.uuid "event_record_id", null: false
    t.integer "ordinal", null: false
    t.datetime "updated_at", null: false
    t.index ["dependency_record_id"], name: "index_record_dependencies_on_dependency_record_id"
    t.index ["event_record_id", "dependency_record_id"], name: "index_record_dependencies_on_event_and_dependency", unique: true
    t.index ["event_record_id", "ordinal"], name: "index_record_dependencies_on_event_record_id_and_ordinal", unique: true
    t.index ["event_record_id"], name: "index_record_dependencies_on_event_record_id"
    t.check_constraint "ordinal >= 0", name: "record_dependencies_ordinal"
  end

  create_table "session_credentials", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_session_id", null: false
    t.datetime "consumed_at"
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.string "kind", null: false
    t.datetime "revoked_at"
    t.binary "secret_digest", null: false
    t.datetime "updated_at", null: false
    t.index ["account_session_id", "kind"], name: "index_session_credentials_on_account_session_id_and_kind"
    t.index ["account_session_id"], name: "index_session_credentials_on_account_session_id"
    t.check_constraint "kind::text = ANY (ARRAY['Access'::character varying::text, 'Refresh'::character varying::text])", name: "session_credentials_kind"
    t.check_constraint "octet_length(secret_digest) = 32", name: "session_credentials_digest"
  end

  create_table "signup_registrations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.datetime "created_at", null: false
    t.uuid "idempotency_key", null: false
    t.binary "request_sha256", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_signup_registrations_on_account_id"
    t.index ["idempotency_key"], name: "index_signup_registrations_on_idempotency_key", unique: true
    t.check_constraint "octet_length(request_sha256) = 32", name: "signup_registrations_request_sha256"
  end

  create_table "transfer_tickets", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.uuid "opaque_record_id"
    t.string "purpose", null: false
    t.datetime "revoked_at"
    t.binary "token_sha256", null: false
    t.datetime "updated_at", null: false
    t.uuid "upload_id"
    t.uuid "vault_generation_id"
    t.uuid "vault_replica_id", null: false
    t.index ["account_id"], name: "index_transfer_tickets_on_account_id"
    t.index ["opaque_record_id"], name: "index_transfer_tickets_on_opaque_record_id"
    t.index ["token_sha256"], name: "index_transfer_tickets_on_token_sha256", unique: true
    t.index ["upload_id"], name: "index_transfer_tickets_on_upload_id"
    t.index ["vault_generation_id"], name: "index_transfer_tickets_on_vault_generation_id"
    t.index ["vault_replica_id"], name: "index_transfer_tickets_on_vault_replica_id"
    t.check_constraint "octet_length(token_sha256) = 32", name: "transfer_tickets_token_sha256"
    t.check_constraint "purpose::text = ANY (ARRAY['UploadPart'::character varying::text, 'ActiveDownload'::character varying::text, 'RecoveryDownload'::character varying::text])", name: "transfer_tickets_purpose"
  end

  create_table "upload_parts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.bigint "byte_length", null: false
    t.datetime "created_at", null: false
    t.integer "part_number", null: false
    t.datetime "received_at", null: false
    t.binary "sha256", null: false
    t.string "storage_key", null: false
    t.datetime "updated_at", null: false
    t.uuid "upload_id", null: false
    t.index ["upload_id", "part_number"], name: "index_upload_parts_on_upload_id_and_part_number", unique: true
    t.index ["upload_id"], name: "index_upload_parts_on_upload_id"
    t.check_constraint "byte_length > 0", name: "upload_parts_byte_length"
    t.check_constraint "octet_length(sha256) = 32", name: "upload_parts_sha256"
    t.check_constraint "part_number >= 0", name: "upload_parts_number"
  end

  create_table "uploads", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.datetime "last_activity_at", null: false
    t.bigint "observed_byte_length"
    t.binary "observed_sha256"
    t.uuid "opaque_record_id", null: false
    t.integer "part_count", null: false
    t.bigint "part_size", null: false
    t.string "state", null: false
    t.datetime "updated_at", null: false
    t.index ["opaque_record_id"], name: "index_uploads_on_opaque_record_id", unique: true
    t.check_constraint "observed_sha256 IS NULL OR octet_length(observed_sha256) = 32", name: "uploads_observed_sha256"
    t.check_constraint "part_count > 0", name: "uploads_part_count"
    t.check_constraint "part_size > 0", name: "uploads_part_size"
    t.check_constraint "state::text = ANY (ARRAY['Open'::character varying::text, 'Assembling'::character varying::text, 'Completed'::character varying::text, 'Expired'::character varying::text])", name: "uploads_state"
  end

  create_table "vault_generations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "activated_at"
    t.bigint "baseline_cursor"
    t.datetime "created_at", null: false
    t.uuid "generation_id", null: false
    t.bigint "generation_number", null: false
    t.uuid "generation_record_id"
    t.uuid "predecessor_generation_id"
    t.datetime "purge_after"
    t.datetime "purge_started_at"
    t.datetime "purged_at"
    t.binary "reachability_sha256"
    t.integer "sealed_page_count"
    t.bigint "sealed_record_count"
    t.string "state", null: false
    t.datetime "superseded_at"
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["generation_id"], name: "index_vault_generations_on_generation_id", unique: true
    t.index ["generation_record_id"], name: "index_vault_generations_on_generation_record_id"
    t.index ["predecessor_generation_id"], name: "index_vault_generations_on_predecessor_generation_id"
    t.index ["vault_replica_id", "generation_number"], name: "index_vault_generations_on_vault_and_number", unique: true
    t.index ["vault_replica_id"], name: "index_one_active_generation_per_vault", unique: true, where: "((state)::text = 'Active'::text)"
    t.index ["vault_replica_id"], name: "index_one_candidate_generation_per_vault", unique: true, where: "((state)::text = 'Candidate'::text)"
    t.index ["vault_replica_id"], name: "index_vault_generations_on_vault_replica_id"
    t.check_constraint "generation_number >= 0", name: "vault_generations_number"
    t.check_constraint "reachability_sha256 IS NULL OR octet_length(reachability_sha256) = 32", name: "vault_generations_reachability_sha256"
    t.check_constraint "state::text = ANY (ARRAY['Candidate'::character varying::text, 'Active'::character varying::text, 'Superseded'::character varying::text, 'Purging'::character varying::text, 'Purged'::character varying::text])", name: "vault_generations_state"
  end

  create_table "vault_replicas", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.uuid "account_key_id", null: false
    t.string "account_slot_algorithm", default: "wrap:xchacha20poly1305:account:v1", null: false
    t.binary "account_slot_ciphertext", null: false
    t.uuid "account_slot_id", null: false
    t.binary "account_slot_nonce", null: false
    t.uuid "active_generation_id"
    t.bigint "active_generation_number"
    t.datetime "created_at", null: false
    t.bigint "head_cursor", default: 0, null: false
    t.datetime "provisional_expires_at"
    t.string "state", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_id", null: false
    t.index ["account_id"], name: "index_vault_replicas_on_account_id", unique: true
    t.index ["account_slot_id"], name: "index_vault_replicas_on_account_slot_id", unique: true
    t.index ["vault_id"], name: "index_vault_replicas_on_vault_id", unique: true
    t.check_constraint "account_slot_algorithm::text = 'wrap:xchacha20poly1305:account:v1'::text", name: "vault_replicas_account_slot_algorithm"
    t.check_constraint "active_generation_number IS NULL OR active_generation_number >= 0", name: "vault_replicas_generation_number"
    t.check_constraint "head_cursor >= 0", name: "vault_replicas_head_cursor"
    t.check_constraint "octet_length(account_slot_ciphertext) >= 48", name: "vault_replicas_account_slot_ciphertext"
    t.check_constraint "octet_length(account_slot_nonce) = 24", name: "vault_replicas_account_slot_nonce"
    t.check_constraint "state::text = ANY (ARRAY['Provisional'::character varying::text, 'Active'::character varying::text])", name: "vault_replicas_state"
  end

  add_foreign_key "account_sessions", "accounts"
  add_foreign_key "delivery_changes", "event_commits"
  add_foreign_key "delivery_changes", "vault_generations"
  add_foreign_key "delivery_changes", "vault_replicas"
  add_foreign_key "event_commits", "opaque_records", column: "event_record_id"
  add_foreign_key "event_commits", "vault_generations"
  add_foreign_key "event_commits", "vault_replicas"
  add_foreign_key "generation_memberships", "opaque_records"
  add_foreign_key "generation_memberships", "vault_generations"
  add_foreign_key "generation_reachability_entries", "generation_reachability_pages"
  add_foreign_key "generation_reachability_entries", "opaque_records"
  add_foreign_key "generation_reachability_entries", "vault_generations"
  add_foreign_key "generation_reachability_pages", "vault_generations"
  add_foreign_key "idempotency_records", "accounts"
  add_foreign_key "opaque_records", "vault_generations", column: "target_generation_id", primary_key: "generation_id"
  add_foreign_key "opaque_records", "vault_replicas"
  add_foreign_key "purge_job_generations", "purge_jobs"
  add_foreign_key "purge_job_generations", "vault_generations"
  add_foreign_key "purge_jobs", "vault_replicas"
  add_foreign_key "record_dependencies", "opaque_records", column: "dependency_record_id"
  add_foreign_key "record_dependencies", "opaque_records", column: "event_record_id"
  add_foreign_key "session_credentials", "account_sessions"
  add_foreign_key "signup_registrations", "accounts"
  add_foreign_key "transfer_tickets", "accounts"
  add_foreign_key "transfer_tickets", "opaque_records"
  add_foreign_key "transfer_tickets", "uploads"
  add_foreign_key "transfer_tickets", "vault_generations"
  add_foreign_key "transfer_tickets", "vault_replicas"
  add_foreign_key "upload_parts", "uploads"
  add_foreign_key "uploads", "opaque_records"
  add_foreign_key "vault_generations", "opaque_records", column: "generation_record_id"
  add_foreign_key "vault_generations", "vault_generations", column: "predecessor_generation_id"
  add_foreign_key "vault_generations", "vault_replicas"
  add_foreign_key "vault_replicas", "accounts"
  add_foreign_key "vault_replicas", "vault_generations", column: "active_generation_id"
end
