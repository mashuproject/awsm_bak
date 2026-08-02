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
    t.check_constraint "reason::text = ANY (ARRAY['Manual'::character varying, 'Inactivity'::character varying]::text[])", name: "account_deletion_jobs_reason"
    t.check_constraint "receipt_digest IS NULL OR octet_length(receipt_digest) = 32", name: "account_deletion_jobs_receipt_digest"
    t.check_constraint "stage::text = ANY (ARRAY['Freeze'::character varying, 'RevokeAccess'::character varying, 'ReapReplicas'::character varying, 'DeleteIdentity'::character varying, 'Complete'::character varying]::text[])", name: "account_deletion_jobs_stage"
    t.check_constraint "state::text = ANY (ARRAY['Pending'::character varying, 'Running'::character varying, 'FailedRetryable'::character varying, 'Succeeded'::character varying]::text[])", name: "account_deletion_jobs_state"
    t.check_constraint "total_bytes >= 0 AND processed_bytes >= 0 AND processed_bytes <= total_bytes AND retry_count >= 0", name: "account_deletion_jobs_counters"
  end

  create_table "accounts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.datetime "last_activity_at", null: false
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
    t.uuid "channel_principal_id", null: false
    t.datetime "confirmed_at", null: false
    t.datetime "created_at", null: false
    t.datetime "revoked_at"
    t.datetime "updated_at", null: false
    t.index ["channel_principal_id"], name: "index_api_sessions_on_channel_principal_id"
  end

  create_table "browser_sessions", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "channel_principal_id", null: false
    t.string "client_family", null: false
    t.datetime "created_at", null: false
    t.datetime "last_activity_at", null: false
    t.datetime "updated_at", null: false
    t.index ["channel_principal_id", "last_activity_at"], name: "idx_on_channel_principal_id_last_activity_at_b41c03cc7b"
    t.index ["channel_principal_id"], name: "index_browser_sessions_on_channel_principal_id"
    t.check_constraint "client_family::text = ANY (ARRAY['Chrome'::character varying, 'Firefox'::character varying, 'Other'::character varying]::text[])", name: "browser_sessions_client_family"
  end

  create_table "channel_authenticators", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "authenticator_type", null: false
    t.uuid "channel_principal_id", null: false
    t.datetime "created_at", null: false
    t.datetime "last_used_at"
    t.string "password_digest", null: false
    t.datetime "revoked_at"
    t.datetime "updated_at", null: false
    t.index ["channel_principal_id"], name: "index_channel_authenticators_on_channel_principal_id"
    t.index ["channel_principal_id"], name: "index_one_active_password_authenticator", unique: true, where: "(((authenticator_type)::text = 'Password'::text) AND (revoked_at IS NULL))"
    t.check_constraint "authenticator_type::text = 'Password'::text", name: "channel_authenticators_type"
    t.check_constraint "char_length(password_digest::text) > 0", name: "channel_authenticators_password_digest"
  end

  create_table "channel_principals", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_id", null: false
    t.datetime "created_at", null: false
    t.string "principal_type", null: false
    t.string "state", default: "Active", null: false
    t.datetime "updated_at", null: false
    t.index ["account_id"], name: "index_channel_principals_on_account_id", unique: true
    t.check_constraint "principal_type::text = 'Account'::text", name: "channel_principals_type"
    t.check_constraint "state::text = ANY (ARRAY['Active'::character varying, 'Revoked'::character varying]::text[])", name: "channel_principals_state"
  end

  create_table "hosted_replica_reaping_jobs", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "account_deletion_job_id"
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.string "error_outcome"
    t.uuid "hosted_replica_id"
    t.bigint "processed_bytes", default: 0, null: false
    t.string "reason", null: false
    t.integer "retry_count", default: 0, null: false
    t.string "stage", null: false
    t.datetime "started_at"
    t.string "state", null: false
    t.bigint "total_bytes", default: 0, null: false
    t.datetime "updated_at", null: false
    t.index ["account_deletion_job_id"], name: "index_hosted_replica_reaping_jobs_on_account_deletion_job_id"
    t.index ["hosted_replica_id"], name: "index_hosted_replica_reaping_jobs_on_hosted_replica_id"
    t.index ["hosted_replica_id"], name: "index_one_active_hosted_replica_reaping", unique: true, where: "((hosted_replica_id IS NOT NULL) AND ((state)::text <> 'Succeeded'::text))"
    t.check_constraint "reason::text = ANY (ARRAY['Manual'::character varying, 'NoActiveGrants'::character varying, 'AccountDeletion'::character varying]::text[])", name: "hosted_replica_reaping_jobs_reason"
    t.check_constraint "stage::text = ANY (ARRAY['Freeze'::character varying, 'DeleteOpaqueBytes'::character varying, 'DeletePolicy'::character varying, 'Complete'::character varying]::text[])", name: "hosted_replica_reaping_jobs_stage"
    t.check_constraint "state::text = ANY (ARRAY['Pending'::character varying, 'Running'::character varying, 'FailedRetryable'::character varying, 'Succeeded'::character varying]::text[])", name: "hosted_replica_reaping_jobs_state"
    t.check_constraint "total_bytes >= 0 AND processed_bytes >= 0 AND processed_bytes <= total_bytes AND retry_count >= 0", name: "hosted_replica_reaping_jobs_counters"
  end

  create_table "hosted_replicas", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.datetime "created_at", null: false
    t.bigint "hint_cursor", default: 0, null: false
    t.bigint "inventory_cursor", default: 0, null: false
    t.string "management_label"
    t.bigint "quota_bytes"
    t.string "state", default: "Active", null: false
    t.bigint "stored_bytes", default: 0, null: false
    t.datetime "updated_at", null: false
    t.check_constraint "inventory_cursor >= 0 AND hint_cursor >= 0", name: "hosted_replicas_cursors"
    t.check_constraint "management_label IS NULL OR char_length(management_label::text) >= 1 AND char_length(management_label::text) <= 80", name: "hosted_replicas_management_label"
    t.check_constraint "quota_bytes IS NULL OR quota_bytes > 0", name: "hosted_replicas_quota"
    t.check_constraint "state::text = ANY (ARRAY['Active'::character varying, 'Reaping'::character varying]::text[])", name: "hosted_replicas_state"
    t.check_constraint "stored_bytes >= 0 AND (quota_bytes IS NULL OR stored_bytes <= quota_bytes)", name: "hosted_replicas_stored_bytes"
  end

  create_table "idempotency_records", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "canonical_path", null: false
    t.uuid "channel_principal_id", null: false
    t.datetime "created_at", null: false
    t.string "http_method", null: false
    t.uuid "idempotency_key", null: false
    t.string "operation", null: false
    t.binary "request_sha256", null: false
    t.uuid "resource_id"
    t.string "resource_type"
    t.string "status", null: false
    t.datetime "updated_at", null: false
    t.index ["channel_principal_id", "operation", "idempotency_key"], name: "index_idempotency_on_principal_operation_key", unique: true
    t.index ["channel_principal_id"], name: "index_idempotency_records_on_channel_principal_id"
    t.check_constraint "octet_length(request_sha256) = 32", name: "idempotency_records_request_sha256"
    t.check_constraint "status::text = ANY (ARRAY['InProgress'::character varying, 'Succeeded'::character varying]::text[])", name: "idempotency_records_status"
  end

  create_table "opaque_storage_items", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.uuid "admitted_by_grant_id"
    t.bigint "byte_length", null: false
    t.binary "ciphertext_digest", null: false
    t.datetime "created_at", null: false
    t.uuid "hosted_replica_id", null: false
    t.bigint "inventory_cursor", null: false
    t.string "storage_class", null: false
    t.binary "storage_item_id", null: false
    t.string "storage_key", null: false
    t.datetime "updated_at", null: false
    t.index ["admitted_by_grant_id"], name: "index_opaque_storage_items_on_admitted_by_grant_id"
    t.index ["hosted_replica_id", "inventory_cursor"], name: "index_opaque_items_on_replica_and_cursor", unique: true
    t.index ["hosted_replica_id", "storage_item_id"], name: "index_opaque_items_on_replica_and_item", unique: true
    t.index ["hosted_replica_id"], name: "index_opaque_storage_items_on_hosted_replica_id"
    t.index ["storage_key"], name: "index_opaque_storage_items_on_storage_key", unique: true
    t.check_constraint "byte_length > 0 AND inventory_cursor > 0", name: "opaque_storage_items_bounds"
    t.check_constraint "octet_length(ciphertext_digest) = 32", name: "opaque_storage_items_digest"
    t.check_constraint "octet_length(storage_item_id) = 32", name: "opaque_storage_items_identity"
    t.check_constraint "storage_class::text = ANY (ARRAY['Compact'::character varying, 'Streamable'::character varying]::text[])", name: "opaque_storage_items_class"
  end

  create_table "opaque_upload_parts", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.bigint "byte_length", null: false
    t.datetime "created_at", null: false
    t.uuid "opaque_upload_id", null: false
    t.integer "part_number", null: false
    t.binary "sha256", null: false
    t.bigint "start_offset", null: false
    t.string "storage_key", null: false
    t.datetime "updated_at", null: false
    t.index ["opaque_upload_id", "part_number"], name: "index_opaque_upload_parts_on_opaque_upload_id_and_part_number", unique: true
    t.index ["opaque_upload_id", "start_offset"], name: "index_opaque_upload_parts_on_opaque_upload_id_and_start_offset", unique: true
    t.index ["opaque_upload_id"], name: "index_opaque_upload_parts_on_opaque_upload_id"
    t.index ["storage_key"], name: "index_opaque_upload_parts_on_storage_key", unique: true
    t.check_constraint "octet_length(sha256) = 32", name: "opaque_upload_parts_digest"
    t.check_constraint "part_number >= 0 AND start_offset >= 0 AND byte_length > 0", name: "opaque_upload_parts_bounds"
  end

  create_table "opaque_uploads", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.bigint "accepted_offset", default: 0, null: false
    t.bigint "byte_length", null: false
    t.binary "ciphertext_digest", null: false
    t.datetime "created_at", null: false
    t.datetime "expires_at", null: false
    t.uuid "hosted_replica_id", null: false
    t.uuid "replica_access_grant_id", null: false
    t.string "state", default: "Preparing", null: false
    t.binary "storage_item_id", null: false
    t.string "storage_key", null: false
    t.datetime "updated_at", null: false
    t.index ["hosted_replica_id", "storage_item_id"], name: "index_one_preparing_upload_per_item", unique: true, where: "((state)::text = 'Preparing'::text)"
    t.index ["hosted_replica_id"], name: "index_opaque_uploads_on_hosted_replica_id"
    t.index ["replica_access_grant_id"], name: "index_opaque_uploads_on_replica_access_grant_id"
    t.index ["storage_key"], name: "index_opaque_uploads_on_storage_key", unique: true
    t.check_constraint "byte_length > 0 AND accepted_offset >= 0 AND accepted_offset <= byte_length", name: "opaque_uploads_bounds"
    t.check_constraint "octet_length(ciphertext_digest) = 32", name: "opaque_uploads_digest"
    t.check_constraint "octet_length(storage_item_id) = 32", name: "opaque_uploads_identity"
    t.check_constraint "state::text = ANY (ARRAY['Preparing'::character varying, 'Promoting'::character varying]::text[])", name: "opaque_uploads_state"
  end

  create_table "replica_access_grants", id: :uuid, default: -> { "gen_random_uuid()" }, force: :cascade do |t|
    t.string "capabilities", default: [], null: false, array: true
    t.uuid "channel_principal_id", null: false
    t.datetime "created_at", null: false
    t.uuid "created_by_grant_id"
    t.string "grantable_capabilities", default: [], null: false, array: true
    t.uuid "hosted_replica_id", null: false
    t.datetime "revoked_at"
    t.datetime "updated_at", null: false
    t.index ["channel_principal_id"], name: "index_replica_access_grants_on_channel_principal_id"
    t.index ["hosted_replica_id", "channel_principal_id"], name: "index_one_active_grant_per_principal_and_replica", unique: true, where: "(revoked_at IS NULL)"
    t.index ["hosted_replica_id"], name: "index_replica_access_grants_on_hosted_replica_id"
    t.check_constraint "cardinality(capabilities) > 0 AND capabilities <@ ARRAY['awsm.replica.hint.read'::character varying, 'awsm.replica.hint.write'::character varying, 'awsm.replica.inventory.read'::character varying, 'awsm.replica.item.read'::character varying, 'awsm.replica.item.write'::character varying, 'awsm.replica.manage'::character varying]", name: "replica_access_grants_capabilities"
    t.check_constraint "grantable_capabilities <@ capabilities", name: "replica_access_grants_grantable_capabilities"
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
    t.check_constraint "octet_length(secret_digest) = 32", name: "session_credentials_secret_digest"
  end

  add_foreign_key "account_deletion_jobs", "accounts", on_delete: :nullify
  add_foreign_key "api_sessions", "channel_principals", on_delete: :cascade
  add_foreign_key "browser_sessions", "channel_principals", on_delete: :cascade
  add_foreign_key "channel_authenticators", "channel_principals", on_delete: :cascade
  add_foreign_key "channel_principals", "accounts", on_delete: :cascade
  add_foreign_key "hosted_replica_reaping_jobs", "account_deletion_jobs", on_delete: :cascade
  add_foreign_key "hosted_replica_reaping_jobs", "hosted_replicas", on_delete: :nullify
  add_foreign_key "idempotency_records", "channel_principals", on_delete: :cascade
  add_foreign_key "opaque_storage_items", "hosted_replicas", on_delete: :cascade
  add_foreign_key "opaque_storage_items", "replica_access_grants", column: "admitted_by_grant_id", on_delete: :nullify
  add_foreign_key "opaque_upload_parts", "opaque_uploads", on_delete: :cascade
  add_foreign_key "opaque_uploads", "hosted_replicas", on_delete: :cascade
  add_foreign_key "opaque_uploads", "replica_access_grants", on_delete: :cascade
  add_foreign_key "replica_access_grants", "channel_principals", on_delete: :cascade
  add_foreign_key "replica_access_grants", "hosted_replicas", on_delete: :cascade
  add_foreign_key "replica_access_grants", "replica_access_grants", column: "created_by_grant_id", on_delete: :restrict
  add_foreign_key "session_credentials", "api_sessions", on_delete: :cascade
end
