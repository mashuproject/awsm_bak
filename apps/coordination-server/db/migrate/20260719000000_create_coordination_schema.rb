class CreateCoordinationSchema < ActiveRecord::Migration[8.1]
  def change
    enable_extension "pgcrypto"

    create_table :accounts, id: :uuid do |table|
      table.string :email, null: false
      table.string :password_digest, null: false
      table.timestamps
    end
    add_index :accounts, :email, unique: true
    add_check_constraint :accounts, "email = lower(email)", name: "accounts_normalized_email"

    create_table :browser_sessions, id: :uuid do |table|
      table.references :account, null: false, type: :uuid, foreign_key: true
      table.string :ip_address
      table.string :user_agent
      table.timestamps
    end

    create_table :api_sessions, id: :uuid do |table|
      table.references :account, null: false, type: :uuid, foreign_key: true
      table.uuid :vault_device_id
      table.string :scope, null: false
      table.datetime :confirmed_at, null: false
      table.datetime :revoked_at
      table.timestamps
    end
    add_check_constraint :api_sessions,
      "(scope = 'Account' AND vault_device_id IS NULL) OR " \
      "(scope = 'VaultDevice' AND vault_device_id IS NOT NULL)",
      name: "api_sessions_scope_binding"
    add_check_constraint :api_sessions, "scope IN ('Account', 'VaultDevice')",
      name: "api_sessions_scope"

    create_table :session_credentials, id: :uuid do |table|
      table.references :api_session, null: false, type: :uuid, foreign_key: true
      table.string :kind, null: false
      table.binary :secret_digest, null: false
      table.datetime :expires_at, null: false
      table.datetime :consumed_at
      table.datetime :revoked_at
      table.timestamps
    end
    add_index :session_credentials, [ :api_session_id, :kind ]
    add_check_constraint :session_credentials, "kind IN ('Access', 'Refresh')",
      name: "session_credentials_kind"
    add_check_constraint :session_credentials, "octet_length(secret_digest) = 32",
      name: "session_credentials_digest"

    create_table :vault_replicas, id: :uuid do |table|
      table.references :account, null: false, type: :uuid, foreign_key: true
      table.uuid :vault_id, null: false
      table.string :state, null: false
      table.uuid :active_generation_id
      table.uuid :active_key_epoch_id
      table.uuid :active_recovery_generation_id
      table.bigint :active_generation_number
      table.bigint :head_cursor, null: false, default: 0
      table.datetime :provisional_expires_at
      table.datetime :replaced_at
      table.timestamps
    end
    add_index :vault_replicas, :vault_id, unique: true
    add_index :vault_replicas, :account_id, unique: true, where: "state = 'Active'",
      name: "index_one_active_vault_per_account"
    add_index :vault_replicas, :account_id, unique: true, where: "state = 'Provisional'",
      name: "index_one_provisional_vault_per_account"
    add_check_constraint :vault_replicas, "state IN ('Provisional', 'Active', 'Replaced')",
      name: "vault_replicas_state"
    add_check_constraint :vault_replicas, "head_cursor >= 0", name: "vault_replicas_head_cursor"
    add_check_constraint :vault_replicas,
      "active_generation_number IS NULL OR active_generation_number >= 0",
      name: "vault_replicas_generation_number"

    create_table :recovery_generations, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.bigint :ordinal, null: false
      table.string :derivation_algorithm, null: false
      table.string :wrapping_algorithm, null: false
      table.string :administrator_signing_algorithm, null: false
      table.binary :administrator_public_key, null: false
      table.binary :kit_nonce, null: false
      table.binary :kit_ciphertext
      table.bigint :kit_ciphertext_length, null: false
      table.binary :kit_ciphertext_sha256, null: false
      table.datetime :activated_at
      table.datetime :retired_at
      table.timestamps
    end
    add_index :recovery_generations, [ :vault_replica_id, :ordinal ], unique: true
    add_index :recovery_generations, :vault_replica_id, unique: true,
      where: "activated_at IS NOT NULL AND retired_at IS NULL",
      name: "index_one_active_recovery_generation_per_vault"
    add_check_constraint :recovery_generations, "ordinal >= 0",
      name: "recovery_generations_ordinal"
    add_check_constraint :recovery_generations,
      "derivation_algorithm = 'kdf:hkdf-sha256:recovery-entropy:v1'",
      name: "recovery_generations_derivation"
    add_check_constraint :recovery_generations,
      "wrapping_algorithm = 'wrap:xchacha20poly1305:recovery-kit:v1'",
      name: "recovery_generations_wrapping"
    add_check_constraint :recovery_generations,
      "administrator_signing_algorithm = 'sign:ed25519:recovery-administrator:v1'",
      name: "recovery_generations_signing"
    add_check_constraint :recovery_generations, "octet_length(administrator_public_key) = 32",
      name: "recovery_generations_public_key"
    add_check_constraint :recovery_generations, "octet_length(kit_nonce) = 24",
      name: "recovery_generations_nonce"
    add_check_constraint :recovery_generations,
      "kit_ciphertext IS NULL OR octet_length(kit_ciphertext) = kit_ciphertext_length",
      name: "recovery_generations_ciphertext"
    add_check_constraint :recovery_generations, "kit_ciphertext_length >= 16",
      name: "recovery_generations_ciphertext_length"
    add_check_constraint :recovery_generations, "octet_length(kit_ciphertext_sha256) = 32",
      name: "recovery_generations_ciphertext_sha256"
    add_check_constraint :recovery_generations,
      "(retired_at IS NULL AND kit_ciphertext IS NOT NULL) OR retired_at IS NOT NULL",
      name: "recovery_generations_retired_ciphertext"

    create_table :vault_key_epochs, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :recovery_generation, null: false, type: :uuid, foreign_key: true
      table.bigint :ordinal, null: false
      table.datetime :activated_at, null: false
      table.datetime :retired_at
      table.timestamps
    end
    add_index :vault_key_epochs, [ :vault_replica_id, :ordinal ], unique: true
    add_index :vault_key_epochs, :vault_replica_id, unique: true,
      where: "retired_at IS NULL", name: "index_one_active_key_epoch_per_vault"
    add_check_constraint :vault_key_epochs, "ordinal >= 0", name: "vault_key_epochs_ordinal"

    create_table :vault_devices, id: :uuid, primary_key: :device_id do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :recovery_generation, null: false, type: :uuid, foreign_key: true
      table.uuid :certificate_id, null: false
      table.string :display_name, null: false
      table.string :client_kind, null: false
      table.string :signing_algorithm, null: false
      table.binary :signing_public_key, null: false
      table.string :wrapping_algorithm, null: false
      table.binary :wrapping_public_key, null: false
      table.binary :certificate_cbor, null: false
      table.binary :certificate_signature, null: false
      table.datetime :enrolled_at, null: false
      table.datetime :revoked_at
      table.string :revocation_reason
      table.timestamps
    end
    add_index :vault_devices, :certificate_id, unique: true
    add_index :vault_devices, [ :vault_replica_id, :device_id ], unique: true
    add_check_constraint :vault_devices,
      "client_kind IN ('ChromeExtension', 'FirefoxExtension')",
      name: "vault_devices_client_kind"
    add_check_constraint :vault_devices, "signing_algorithm = 'sign:ed25519:device:v1'",
      name: "vault_devices_signing_algorithm"
    add_check_constraint :vault_devices, "octet_length(signing_public_key) = 32",
      name: "vault_devices_signing_public_key"
    add_check_constraint :vault_devices,
      "wrapping_algorithm = 'wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1'",
      name: "vault_devices_wrapping_algorithm"
    add_check_constraint :vault_devices, "octet_length(wrapping_public_key) = 32",
      name: "vault_devices_wrapping_public_key"
    add_check_constraint :vault_devices, "octet_length(certificate_signature) = 64",
      name: "vault_devices_certificate_signature"
    add_check_constraint :vault_devices,
      "(revoked_at IS NULL AND revocation_reason IS NULL) OR " \
      "(revoked_at IS NOT NULL AND revocation_reason IN ('Removed', 'FutureProtection', 'VaultReencrypted'))",
      name: "vault_devices_revocation"

    create_table :device_key_envelopes, id: :uuid do |table|
      table.references :vault_device, null: false, type: :uuid, foreign_key: {
        to_table: :vault_devices, primary_key: :device_id
      }
      table.references :vault_key_epoch, null: false, type: :uuid,
        foreign_key: { to_table: :vault_key_epochs }
      table.references :recovery_generation, null: false, type: :uuid, foreign_key: true
      table.string :algorithm, null: false
      table.binary :ephemeral_public_key, null: false
      table.binary :nonce, null: false
      table.binary :ciphertext, null: false
      table.binary :ciphertext_sha256, null: false
      table.binary :signed_metadata, null: false
      table.binary :administrator_signature, null: false
      table.timestamps
    end
    add_index :device_key_envelopes, [ :vault_device_id, :vault_key_epoch_id ], unique: true,
      name: "index_device_envelopes_on_device_and_epoch"
    add_check_constraint :device_key_envelopes,
      "algorithm = 'wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1'",
      name: "device_key_envelopes_algorithm"
    add_check_constraint :device_key_envelopes, "octet_length(ephemeral_public_key) = 32",
      name: "device_key_envelopes_ephemeral_public_key"
    add_check_constraint :device_key_envelopes, "octet_length(nonce) = 24",
      name: "device_key_envelopes_nonce"
    add_check_constraint :device_key_envelopes, "octet_length(ciphertext) = 48",
      name: "device_key_envelopes_ciphertext"
    add_check_constraint :device_key_envelopes, "octet_length(ciphertext_sha256) = 32",
      name: "device_key_envelopes_ciphertext_sha256"
    add_check_constraint :device_key_envelopes, "octet_length(administrator_signature) = 64",
      name: "device_key_envelopes_administrator_signature"

    add_foreign_key :api_sessions, :vault_devices, column: :vault_device_id,
      primary_key: :device_id

    create_table :opaque_records, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :vault_key_epoch, null: false, type: :uuid,
        foreign_key: { to_table: :vault_key_epochs }
      table.uuid :object_id, null: false
      table.string :object_type, null: false
      table.bigint :byte_length, null: false
      table.binary :sha256, null: false
      table.string :storage_key
      table.string :state, null: false
      table.uuid :target_generation_id, null: false
      table.datetime :event_ordering_timestamp
      table.datetime :durable_at
      table.datetime :committed_at
      table.datetime :purged_at
      table.timestamps
    end
    add_index :opaque_records, :object_id, unique: true
    add_index :opaque_records, [ :vault_replica_id, :state ]
    add_index :opaque_records, [ :vault_replica_id, :target_generation_id ]
    add_check_constraint :opaque_records,
      "object_type IN ('Event', 'BundleDescriptor', 'Artifact', 'VaultGeneration')",
      name: "opaque_records_type"
    add_check_constraint :opaque_records,
      "state IN ('Uploading', 'DurableUncommitted', 'Committed', 'Purged')",
      name: "opaque_records_state"
    add_check_constraint :opaque_records, "byte_length > 0", name: "opaque_records_byte_length"
    add_check_constraint :opaque_records, "octet_length(sha256) = 32", name: "opaque_records_sha256"
    add_check_constraint :opaque_records,
      "(object_type = 'Event' AND event_ordering_timestamp IS NOT NULL) OR " \
      "(object_type <> 'Event' AND event_ordering_timestamp IS NULL)",
      name: "opaque_records_event_metadata"

    create_table :record_dependencies, id: :uuid do |table|
      table.references :event_record, null: false, type: :uuid,
        foreign_key: { to_table: :opaque_records }
      table.references :dependency_record, null: false, type: :uuid,
        foreign_key: { to_table: :opaque_records }
      table.integer :ordinal, null: false
      table.timestamps
    end
    add_index :record_dependencies, [ :event_record_id, :ordinal ], unique: true
    add_index :record_dependencies, [ :event_record_id, :dependency_record_id ], unique: true,
      name: "index_record_dependencies_on_event_and_dependency"
    add_check_constraint :record_dependencies, "ordinal >= 0", name: "record_dependencies_ordinal"

    create_table :uploads, id: :uuid do |table|
      table.references :opaque_record, null: false, type: :uuid, foreign_key: true,
        index: { unique: true }
      table.string :state, null: false
      table.bigint :part_size, null: false
      table.integer :part_count, null: false
      table.datetime :expires_at, null: false
      table.bigint :observed_byte_length
      table.binary :observed_sha256
      table.datetime :last_activity_at, null: false
      table.datetime :completed_at
      table.timestamps
    end
    add_check_constraint :uploads,
      "state IN ('Open', 'Assembling', 'Completed', 'Expired')",
      name: "uploads_state"
    add_check_constraint :uploads, "part_size > 0", name: "uploads_part_size"
    add_check_constraint :uploads, "part_count > 0", name: "uploads_part_count"
    add_check_constraint :uploads,
      "observed_sha256 IS NULL OR octet_length(observed_sha256) = 32",
      name: "uploads_observed_sha256"

    create_table :upload_parts, id: :uuid do |table|
      table.references :upload, null: false, type: :uuid, foreign_key: true
      table.integer :part_number, null: false
      table.bigint :byte_length, null: false
      table.binary :sha256, null: false
      table.string :storage_key, null: false
      table.datetime :received_at, null: false
      table.timestamps
    end
    add_index :upload_parts, [ :upload_id, :part_number ], unique: true
    add_check_constraint :upload_parts, "part_number >= 0", name: "upload_parts_number"
    add_check_constraint :upload_parts, "byte_length > 0", name: "upload_parts_byte_length"
    add_check_constraint :upload_parts, "octet_length(sha256) = 32", name: "upload_parts_sha256"

    create_table :vault_generations, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.uuid :generation_id, null: false
      table.bigint :generation_number, null: false
      table.references :predecessor_generation, type: :uuid,
        foreign_key: { to_table: :vault_generations }
      table.references :generation_record, type: :uuid,
        foreign_key: { to_table: :opaque_records }
      table.string :state, null: false
      table.bigint :baseline_cursor
      table.integer :sealed_page_count
      table.bigint :sealed_record_count
      table.binary :reachability_sha256
      table.datetime :activated_at
      table.datetime :superseded_at
      table.datetime :purge_after
      table.datetime :purge_started_at
      table.datetime :purged_at
      table.timestamps
    end
    add_index :vault_generations, :generation_id, unique: true
    add_index :vault_generations, [ :vault_replica_id, :generation_number ], unique: true,
      name: "index_vault_generations_on_vault_and_number"
    add_index :vault_generations, :vault_replica_id, unique: true,
      where: "state = 'Active'", name: "index_one_active_generation_per_vault"
    add_index :vault_generations, :vault_replica_id, unique: true,
      where: "state = 'Candidate'", name: "index_one_candidate_generation_per_vault"
    add_check_constraint :vault_generations,
      "state IN ('Candidate', 'Active', 'Superseded', 'Purging', 'Purged')",
      name: "vault_generations_state"
    add_check_constraint :vault_generations, "generation_number >= 0", name: "vault_generations_number"
    add_check_constraint :vault_generations,
      "reachability_sha256 IS NULL OR octet_length(reachability_sha256) = 32",
      name: "vault_generations_reachability_sha256"

    add_foreign_key :vault_replicas, :vault_generations, column: :active_generation_id
    add_foreign_key :opaque_records, :vault_generations, column: :target_generation_id,
      primary_key: :generation_id

    create_table :generation_reachability_pages, id: :uuid do |table|
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.integer :page_number, null: false
      table.integer :entry_count, null: false
      table.binary :sha256, null: false
      table.datetime :accepted_at, null: false
      table.timestamps
    end
    add_index :generation_reachability_pages, [ :vault_generation_id, :page_number ], unique: true,
      name: "index_reachability_pages_on_generation_and_number"
    add_check_constraint :generation_reachability_pages, "page_number >= 0",
      name: "generation_reachability_pages_number"
    add_check_constraint :generation_reachability_pages, "entry_count >= 0",
      name: "generation_reachability_pages_count"
    add_check_constraint :generation_reachability_pages, "octet_length(sha256) = 32",
      name: "generation_reachability_pages_sha256"

    create_table :generation_reachability_entries, id: :uuid do |table|
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.references :generation_reachability_page, null: false, type: :uuid, foreign_key: true
      table.references :opaque_record, null: false, type: :uuid, foreign_key: true
      table.integer :ordinal, null: false
      table.timestamps
    end
    add_index :generation_reachability_entries,
      [ :generation_reachability_page_id, :ordinal ], unique: true,
      name: "index_reachability_entries_on_page_and_ordinal"
    add_index :generation_reachability_entries,
      [ :vault_generation_id, :opaque_record_id ], unique: true,
      name: "index_reachability_entries_on_generation_and_record"
    add_check_constraint :generation_reachability_entries, "ordinal >= 0",
      name: "generation_reachability_entries_ordinal"

    create_table :generation_memberships, id: :uuid do |table|
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.references :opaque_record, null: false, type: :uuid, foreign_key: true
      table.timestamps
    end
    add_index :generation_memberships, [ :vault_generation_id, :opaque_record_id ], unique: true,
      name: "index_generation_memberships_on_generation_and_record"

    create_table :event_commits, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.references :event_record, null: false, type: :uuid,
        foreign_key: { to_table: :opaque_records }, index: { unique: true }
      table.bigint :cursor, null: false
      table.binary :request_sha256, null: false
      table.datetime :committed_at, null: false
      table.timestamps
    end
    add_index :event_commits, [ :vault_replica_id, :cursor ], unique: true
    add_check_constraint :event_commits, "cursor > 0", name: "event_commits_cursor"
    add_check_constraint :event_commits, "octet_length(request_sha256) = 32",
      name: "event_commits_request_sha256"

    create_table :delivery_changes, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.references :event_commit, type: :uuid, foreign_key: true
      table.bigint :cursor, null: false
      table.string :kind, null: false
      table.datetime :accepted_at, null: false
      table.timestamps
    end
    add_index :delivery_changes, [ :vault_replica_id, :cursor ], unique: true
    add_check_constraint :delivery_changes,
      "kind IN ('EventCommitted', 'GenerationActivated')",
      name: "delivery_changes_kind"
    add_check_constraint :delivery_changes, "cursor > 0", name: "delivery_changes_cursor"

    create_table :transfer_tickets, id: :uuid do |table|
      table.references :account, null: false, type: :uuid, foreign_key: true
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.references :upload, type: :uuid, foreign_key: true
      table.references :opaque_record, type: :uuid, foreign_key: true
      table.references :vault_generation, type: :uuid, foreign_key: true
      table.binary :token_sha256, null: false
      table.string :purpose, null: false
      table.datetime :expires_at, null: false
      table.datetime :revoked_at
      table.timestamps
    end
    add_index :transfer_tickets, :token_sha256, unique: true
    add_check_constraint :transfer_tickets,
      "purpose IN ('UploadPart', 'ActiveDownload', 'RecoveryDownload')",
      name: "transfer_tickets_purpose"
    add_check_constraint :transfer_tickets, "octet_length(token_sha256) = 32",
      name: "transfer_tickets_token_sha256"

    create_table :idempotency_records, id: :uuid do |table|
      table.references :account, null: false, type: :uuid, foreign_key: true
      table.uuid :idempotency_key, null: false
      table.string :operation, null: false
      table.string :http_method, null: false
      table.string :canonical_path, null: false
      table.binary :request_sha256, null: false
      table.string :status, null: false
      table.string :resource_type
      table.uuid :resource_id
      table.timestamps
    end
    add_index :idempotency_records, [ :account_id, :operation, :idempotency_key ], unique: true,
      name: "index_idempotency_records_on_account_operation_key"
    add_check_constraint :idempotency_records,
      "status IN ('InProgress', 'Succeeded')", name: "idempotency_records_status"
    add_check_constraint :idempotency_records, "octet_length(request_sha256) = 32",
      name: "idempotency_records_request_sha256"

    create_table :purge_jobs, id: :uuid do |table|
      table.references :vault_replica, null: false, type: :uuid, foreign_key: true
      table.string :state, null: false
      table.string :stage, null: false
      table.string :reason, null: false
      table.bigint :generation_count, null: false, default: 0
      table.bigint :record_count, null: false, default: 0
      table.bigint :processed_bytes, null: false, default: 0
      table.bigint :total_bytes, null: false, default: 0
      table.integer :retry_count, null: false, default: 0
      table.string :error_outcome
      table.datetime :confirmed_at
      table.datetime :started_at
      table.datetime :completed_at
      table.timestamps
    end
    add_index :purge_jobs, :vault_replica_id, unique: true,
      where: "state IN ('Pending', 'Running', 'FailedRetryable')",
      name: "index_one_active_purge_per_vault"
    add_check_constraint :purge_jobs,
      "state IN ('Pending', 'Running', 'Succeeded', 'FailedRetryable')",
      name: "purge_jobs_state"
    add_check_constraint :purge_jobs,
      "stage IN ('Snapshot', 'Detach', 'Analyze', 'DeleteBytes', 'Tombstone', 'Complete')",
      name: "purge_jobs_stage"
    add_check_constraint :purge_jobs,
      "reason IN ('Automatic', 'Manual', 'VaultReplacement')", name: "purge_jobs_reason"
    add_check_constraint :purge_jobs,
      "generation_count >= 0 AND record_count >= 0 AND processed_bytes >= 0 AND " \
      "total_bytes >= 0 AND retry_count >= 0", name: "purge_jobs_counters"

    create_table :purge_job_generations, id: :uuid do |table|
      table.references :purge_job, null: false, type: :uuid, foreign_key: true
      table.references :vault_generation, null: false, type: :uuid, foreign_key: true
      table.timestamps
    end
    add_index :purge_job_generations, [ :purge_job_id, :vault_generation_id ], unique: true,
      name: "index_purge_job_generations_on_job_and_generation"
  end
end
