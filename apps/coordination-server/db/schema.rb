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

  create_table "account_deletion_jobs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id"
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.string "error_outcome"
    t.bigint "processed_bytes", default: 0, null: false
    t.string "reason", null: false
    t.binary "receipt_digest"
    t.datetime "receipt_expires_at"
    t.integer "retry_count", default: 0, null: false
    t.string "stage", null: false
    t.datetime "started_at"
    t.string "state", null: false
    t.bigint "total_bytes", default: 0, null: false
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_account_deletion_jobs_on_account_id"
    t.index ["account_id"], name: "index_one_active_account_deletion", unique: true, where: "((account_id IS NOT NULL) AND ((state)::text <> 'Succeeded'::text))"
    t.check_constraint "reason::text = 'Manual'::text OR receipt_digest IS NULL", name: "account_deletion_jobs_inactivity_receipt"
    t.check_constraint "reason::text = ANY (ARRAY['Manual'::character varying, 'Inactivity'::character varying]::text[])", name: "account_deletion_jobs_reason"
    t.check_constraint "receipt_digest IS NULL OR octet_length(receipt_digest) = 32", name: "account_deletion_jobs_receipt_digest"
    t.check_constraint "stage::text = ANY (ARRAY['Freeze'::character varying, 'DeleteOpaqueBytes'::character varying, 'DeleteRelationalState'::character varying, 'Complete'::character varying]::text[])", name: "account_deletion_jobs_stage"
    t.check_constraint "state::text <> 'Succeeded'::text OR stage::text = 'Complete'::text AND completed_at IS NOT NULL AND account_id IS NULL", name: "account_deletion_jobs_completion"
    t.check_constraint "state::text = ANY (ARRAY['Pending'::character varying, 'Running'::character varying, 'FailedRetryable'::character varying, 'Succeeded'::character varying]::text[])", name: "account_deletion_jobs_state"
    t.check_constraint "total_bytes >= 0 AND processed_bytes >= 0 AND processed_bytes <= total_bytes AND retry_count >= 0", name: "account_deletion_jobs_counters"
  end

  create_table "accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "last_activity_at", null: false
    t.string "password_digest", null: false
    t.string "state", default: "Active", null: false
    t.datetime "updated_at", null: false
    t.string "username", null: false
    t.index ["username"], name: "index_accounts_on_username", unique: true
    t.check_constraint "char_length(username::text) >= 3 AND char_length(username::text) <= 32", name: "accounts_username_length"
    t.check_constraint "state::text = ANY (ARRAY['Active'::character varying, 'Deleting'::character varying]::text[])", name: "accounts_state"
    t.check_constraint "username::text = lower(username::text)", name: "accounts_normalized_username"
    t.check_constraint "username::text ~ '^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$'::text", name: "accounts_username_shape"
  end

  create_table "api_sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.datetime "confirmed_at", null: false
    t.datetime "created_at", null: false
    t.datetime "revoked_at"
    t.string "scope", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_device_id"
    t.index ["account_id"], name: "index_api_sessions_on_account_id"
    t.check_constraint "scope::text = 'Account'::text AND vault_device_id IS NULL OR scope::text = 'VaultDevice'::text AND vault_device_id IS NOT NULL", name: "api_sessions_scope_binding"
    t.check_constraint "scope::text = ANY (ARRAY['Account'::character varying, 'VaultDevice'::character varying]::text[])", name: "api_sessions_scope"
  end

  create_table "browser_sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.string "client_family", null: false
    t.datetime "created_at", null: false
    t.datetime "last_activity_at", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id", "last_activity_at"], name: "index_browser_sessions_on_account_id_and_last_activity_at"
    t.index ["account_id"], name: "index_browser_sessions_on_account_id"
    t.check_constraint "client_family::text = ANY (ARRAY['Chrome'::character varying, 'Firefox'::character varying, 'Other'::character varying]::text[])", name: "browser_sessions_client_family"
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
    t.check_constraint "kind::text = ANY (ARRAY['EventCommitted'::character varying, 'GenerationActivated'::character varying]::text[])", name: "delivery_changes_kind"
  end

  create_table "device_key_envelopes", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.binary "administrator_signature", null: false
    t.string "algorithm", null: false
    t.binary "ciphertext", null: false
    t.binary "ciphertext_sha256", null: false
    t.datetime "created_at", null: false
    t.binary "ephemeral_public_key", null: false
    t.binary "nonce", null: false
    t.uuid "recovery_generation_id", null: false
    t.binary "signed_metadata", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_device_id", null: false
    t.uuid "vault_key_epoch_id", null: false
    t.index ["recovery_generation_id"], name: "index_device_key_envelopes_on_recovery_generation_id"
    t.index ["vault_device_id", "vault_key_epoch_id"], name: "index_device_envelopes_on_device_and_epoch", unique: true
    t.index ["vault_device_id"], name: "index_device_key_envelopes_on_vault_device_id"
    t.index ["vault_key_epoch_id"], name: "index_device_key_envelopes_on_vault_key_epoch_id"
    t.check_constraint "algorithm::text = 'wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1'::text", name: "device_key_envelopes_algorithm"
    t.check_constraint "octet_length(administrator_signature) = 64", name: "device_key_envelopes_administrator_signature"
    t.check_constraint "octet_length(ciphertext) = 48", name: "device_key_envelopes_ciphertext"
    t.check_constraint "octet_length(ciphertext_sha256) = 32", name: "device_key_envelopes_ciphertext_sha256"
    t.check_constraint "octet_length(ephemeral_public_key) = 32", name: "device_key_envelopes_ephemeral_public_key"
    t.check_constraint "octet_length(nonce) = 24", name: "device_key_envelopes_nonce"
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
    t.check_constraint "status::text = ANY (ARRAY['InProgress'::character varying, 'Succeeded'::character varying]::text[])", name: "idempotency_records_status"
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
    t.uuid "vault_key_epoch_id", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["object_id"], name: "index_opaque_records_on_object_id", unique: true
    t.index ["vault_key_epoch_id"], name: "index_opaque_records_on_vault_key_epoch_id"
    t.index ["vault_replica_id", "state"], name: "index_opaque_records_on_vault_replica_id_and_state"
    t.index ["vault_replica_id", "target_generation_id"], name: "idx_on_vault_replica_id_target_generation_id_ff5b12380a"
    t.index ["vault_replica_id"], name: "index_opaque_records_on_vault_replica_id"
    t.check_constraint "byte_length > 0", name: "opaque_records_byte_length"
    t.check_constraint "object_type::text = 'Event'::text AND event_ordering_timestamp IS NOT NULL OR object_type::text <> 'Event'::text AND event_ordering_timestamp IS NULL", name: "opaque_records_event_metadata"
    t.check_constraint "object_type::text = ANY (ARRAY['Event'::character varying, 'BundleDescriptor'::character varying, 'Artifact'::character varying, 'VaultGeneration'::character varying]::text[])", name: "opaque_records_type"
    t.check_constraint "octet_length(sha256) = 32", name: "opaque_records_sha256"
    t.check_constraint "state::text = ANY (ARRAY['Uploading'::character varying, 'DurableUncommitted'::character varying, 'Committed'::character varying, 'Purged'::character varying]::text[])", name: "opaque_records_state"
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
    t.index ["vault_replica_id"], name: "index_one_active_purge_per_vault", unique: true, where: "((state)::text = ANY ((ARRAY['Pending'::character varying, 'Running'::character varying, 'FailedRetryable'::character varying])::text[]))"
    t.index ["vault_replica_id"], name: "index_purge_jobs_on_vault_replica_id"
    t.check_constraint "generation_count >= 0 AND record_count >= 0 AND processed_bytes >= 0 AND total_bytes >= 0 AND retry_count >= 0", name: "purge_jobs_counters"
    t.check_constraint "reason::text = ANY (ARRAY['Automatic'::character varying, 'Manual'::character varying, 'VaultReplacement'::character varying]::text[])", name: "purge_jobs_reason"
    t.check_constraint "stage::text = ANY (ARRAY['Snapshot'::character varying, 'Detach'::character varying, 'Analyze'::character varying, 'DeleteBytes'::character varying, 'Tombstone'::character varying, 'Complete'::character varying]::text[])", name: "purge_jobs_stage"
    t.check_constraint "state::text = ANY (ARRAY['Pending'::character varying, 'Running'::character varying, 'Succeeded'::character varying, 'FailedRetryable'::character varying]::text[])", name: "purge_jobs_state"
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

  create_table "recovery_generations", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "activated_at"
    t.binary "administrator_public_key", null: false
    t.string "administrator_signing_algorithm", null: false
    t.datetime "created_at", null: false
    t.string "derivation_algorithm", null: false
    t.binary "kit_ciphertext"
    t.bigint "kit_ciphertext_length", null: false
    t.binary "kit_ciphertext_sha256", null: false
    t.binary "kit_nonce", null: false
    t.bigint "ordinal", null: false
    t.datetime "retired_at"
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.string "wrapping_algorithm", null: false
    t.index ["vault_replica_id", "ordinal"], name: "index_recovery_generations_on_vault_replica_id_and_ordinal", unique: true
    t.index ["vault_replica_id"], name: "index_one_active_recovery_generation_per_vault", unique: true, where: "((activated_at IS NOT NULL) AND (retired_at IS NULL))"
    t.index ["vault_replica_id"], name: "index_recovery_generations_on_vault_replica_id"
    t.check_constraint "administrator_signing_algorithm::text = 'sign:ed25519:recovery-administrator:v1'::text", name: "recovery_generations_signing"
    t.check_constraint "derivation_algorithm::text = 'kdf:hkdf-sha256:recovery-entropy:v1'::text", name: "recovery_generations_derivation"
    t.check_constraint "kit_ciphertext IS NULL OR octet_length(kit_ciphertext) = kit_ciphertext_length", name: "recovery_generations_ciphertext"
    t.check_constraint "kit_ciphertext_length >= 16", name: "recovery_generations_ciphertext_length"
    t.check_constraint "octet_length(administrator_public_key) = 32", name: "recovery_generations_public_key"
    t.check_constraint "octet_length(kit_ciphertext_sha256) = 32", name: "recovery_generations_ciphertext_sha256"
    t.check_constraint "octet_length(kit_nonce) = 24", name: "recovery_generations_nonce"
    t.check_constraint "ordinal >= 0", name: "recovery_generations_ordinal"
    t.check_constraint "retired_at IS NULL AND kit_ciphertext IS NOT NULL OR retired_at IS NOT NULL", name: "recovery_generations_retired_ciphertext"
    t.check_constraint "wrapping_algorithm::text = 'wrap:xchacha20poly1305:recovery-kit:v1'::text", name: "recovery_generations_wrapping"
  end

  create_table "session_credentials", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "api_session_id", null: false
    t.datetime "consumed_at"
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.string "kind", null: false
    t.datetime "revoked_at"
    t.binary "secret_digest", null: false
    t.datetime "updated_at", null: false
    t.index ["api_session_id", "kind"], name: "index_session_credentials_on_api_session_id_and_kind"
    t.index ["api_session_id"], name: "index_session_credentials_on_api_session_id"
    t.check_constraint "kind::text = ANY (ARRAY['Access'::character varying, 'Refresh'::character varying]::text[])", name: "session_credentials_kind"
    t.check_constraint "octet_length(secret_digest) = 32", name: "session_credentials_digest"
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
    t.check_constraint "purpose::text = ANY (ARRAY['UploadPart'::character varying, 'ActiveDownload'::character varying, 'RecoveryDownload'::character varying]::text[])", name: "transfer_tickets_purpose"
  end

  create_table "upload_parts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.bigint "byte_length", null: false
    t.datetime "created_at", null: false
    t.integer "part_number", null: false
    t.datetime "received_at", null: false
    t.binary "sha256", null: false
    t.string "storage_key"
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
    t.check_constraint "state::text = ANY (ARRAY['Open'::character varying, 'Assembling'::character varying, 'Completed'::character varying, 'Expired'::character varying]::text[])", name: "uploads_state"
  end

  create_table "vault_devices", primary_key: "device_id", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.binary "certificate_cbor", null: false
    t.uuid "certificate_id", null: false
    t.binary "certificate_signature", null: false
    t.string "client_kind", null: false
    t.datetime "created_at", null: false
    t.string "display_name", null: false
    t.datetime "enrolled_at", null: false
    t.uuid "recovery_generation_id", null: false
    t.string "revocation_reason"
    t.datetime "revoked_at"
    t.string "signing_algorithm", null: false
    t.binary "signing_public_key", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.string "wrapping_algorithm", null: false
    t.binary "wrapping_public_key", null: false
    t.index ["certificate_id"], name: "index_vault_devices_on_certificate_id", unique: true
    t.index ["recovery_generation_id"], name: "index_vault_devices_on_recovery_generation_id"
    t.index ["vault_replica_id", "device_id"], name: "index_vault_devices_on_vault_replica_id_and_device_id", unique: true
    t.index ["vault_replica_id"], name: "index_vault_devices_on_vault_replica_id"
    t.check_constraint "client_kind::text = ANY (ARRAY['ChromeExtension'::character varying, 'FirefoxExtension'::character varying]::text[])", name: "vault_devices_client_kind"
    t.check_constraint "octet_length(certificate_signature) = 64", name: "vault_devices_certificate_signature"
    t.check_constraint "octet_length(signing_public_key) = 32", name: "vault_devices_signing_public_key"
    t.check_constraint "octet_length(wrapping_public_key) = 32", name: "vault_devices_wrapping_public_key"
    t.check_constraint "revoked_at IS NULL AND revocation_reason IS NULL OR revoked_at IS NOT NULL AND (revocation_reason::text = ANY (ARRAY['Removed'::character varying, 'FutureProtection'::character varying, 'VaultReencrypted'::character varying]::text[]))", name: "vault_devices_revocation"
    t.check_constraint "signing_algorithm::text = 'sign:ed25519:device:v1'::text", name: "vault_devices_signing_algorithm"
    t.check_constraint "wrapping_algorithm::text = 'wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1'::text", name: "vault_devices_wrapping_algorithm"
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
    t.check_constraint "state::text = ANY (ARRAY['Candidate'::character varying, 'Active'::character varying, 'Superseded'::character varying, 'Purging'::character varying, 'Purged'::character varying]::text[])", name: "vault_generations_state"
  end

  create_table "vault_key_epochs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "activated_at", null: false
    t.datetime "created_at", null: false
    t.bigint "ordinal", null: false
    t.uuid "recovery_generation_id", null: false
    t.datetime "retired_at"
    t.datetime "updated_at", null: false
    t.uuid "vault_replica_id", null: false
    t.index ["recovery_generation_id"], name: "index_vault_key_epochs_on_recovery_generation_id"
    t.index ["vault_replica_id", "ordinal"], name: "index_vault_key_epochs_on_vault_replica_id_and_ordinal", unique: true
    t.index ["vault_replica_id"], name: "index_one_active_key_epoch_per_vault", unique: true, where: "(retired_at IS NULL)"
    t.index ["vault_replica_id"], name: "index_vault_key_epochs_on_vault_replica_id"
    t.check_constraint "ordinal >= 0", name: "vault_key_epochs_ordinal"
  end

  create_table "vault_replicas", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.uuid "active_generation_id"
    t.bigint "active_generation_number"
    t.uuid "active_key_epoch_id"
    t.uuid "active_recovery_generation_id"
    t.datetime "created_at", null: false
    t.bigint "head_cursor", default: 0, null: false
    t.datetime "provisional_expires_at"
    t.datetime "replaced_at"
    t.string "state", null: false
    t.datetime "updated_at", null: false
    t.uuid "vault_id", null: false
    t.index ["account_id"], name: "index_one_active_vault_per_account", unique: true, where: "((state)::text = 'Active'::text)"
    t.index ["account_id"], name: "index_one_provisional_vault_per_account", unique: true, where: "((state)::text = 'Provisional'::text)"
    t.index ["account_id"], name: "index_vault_replicas_on_account_id"
    t.index ["vault_id"], name: "index_vault_replicas_on_vault_id", unique: true
    t.check_constraint "active_generation_number IS NULL OR active_generation_number >= 0", name: "vault_replicas_generation_number"
    t.check_constraint "head_cursor >= 0", name: "vault_replicas_head_cursor"
    t.check_constraint "state::text = ANY (ARRAY['Provisional'::character varying, 'Active'::character varying, 'Replaced'::character varying]::text[])", name: "vault_replicas_state"
  end

  add_foreign_key "account_deletion_jobs", "accounts", on_delete: :nullify
  add_foreign_key "api_sessions", "accounts"
  add_foreign_key "api_sessions", "vault_devices", primary_key: "device_id"
  add_foreign_key "browser_sessions", "accounts"
  add_foreign_key "delivery_changes", "event_commits"
  add_foreign_key "delivery_changes", "vault_generations"
  add_foreign_key "delivery_changes", "vault_replicas"
  add_foreign_key "device_key_envelopes", "recovery_generations"
  add_foreign_key "device_key_envelopes", "vault_devices", primary_key: "device_id"
  add_foreign_key "device_key_envelopes", "vault_key_epochs"
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
  add_foreign_key "opaque_records", "vault_key_epochs"
  add_foreign_key "opaque_records", "vault_replicas"
  add_foreign_key "purge_job_generations", "purge_jobs"
  add_foreign_key "purge_job_generations", "vault_generations"
  add_foreign_key "purge_jobs", "vault_replicas"
  add_foreign_key "record_dependencies", "opaque_records", column: "dependency_record_id"
  add_foreign_key "record_dependencies", "opaque_records", column: "event_record_id"
  add_foreign_key "recovery_generations", "vault_replicas"
  add_foreign_key "session_credentials", "api_sessions"
  add_foreign_key "transfer_tickets", "accounts"
  add_foreign_key "transfer_tickets", "opaque_records"
  add_foreign_key "transfer_tickets", "uploads"
  add_foreign_key "transfer_tickets", "vault_generations"
  add_foreign_key "transfer_tickets", "vault_replicas"
  add_foreign_key "upload_parts", "uploads"
  add_foreign_key "uploads", "opaque_records"
  add_foreign_key "vault_devices", "recovery_generations"
  add_foreign_key "vault_devices", "vault_replicas"
  add_foreign_key "vault_generations", "opaque_records", column: "generation_record_id"
  add_foreign_key "vault_generations", "vault_generations", column: "predecessor_generation_id"
  add_foreign_key "vault_generations", "vault_replicas"
  add_foreign_key "vault_key_epochs", "recovery_generations"
  add_foreign_key "vault_key_epochs", "vault_replicas"
  add_foreign_key "vault_replicas", "accounts"
  add_foreign_key "vault_replicas", "vault_generations", column: "active_generation_id"
end
