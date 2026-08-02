class CreateCoordinationSchema < ActiveRecord::Migration[8.1]
  REPLICA_CAPABILITIES = %w[
    awsm.replica.hint.read
    awsm.replica.hint.write
    awsm.replica.inventory.read
    awsm.replica.item.read
    awsm.replica.item.write
    awsm.replica.manage
  ].freeze

  def change
    enable_extension "pgcrypto"

    create_accounts
    create_channel_identity
    create_sessions
    create_hosted_replicas
    create_replica_access_grants
    create_opaque_storage
    create_idempotency_records
    create_lifecycle_jobs
  end

  private

  def create_accounts
    create_table :accounts, id: :uuid do |table|
      table.string :username, null: false
      table.string :state, null: false, default: "Active"
      table.datetime :last_activity_at, null: false
      table.timestamps
    end
    add_index :accounts, :username, unique: true
    add_check_constraint :accounts, "username = lower(username)",
      name: "accounts_normalized_username"
    add_check_constraint :accounts, "char_length(username) BETWEEN 3 AND 32",
      name: "accounts_username_length"
    add_check_constraint :accounts,
      "username ~ '^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$'",
      name: "accounts_username_shape"
    add_check_constraint :accounts, "state IN ('Active', 'Deleting')",
      name: "accounts_state"
  end

  def create_channel_identity
    create_table :channel_principals, id: :uuid do |table|
      table.string :principal_type, null: false
      table.references :account, null: false, type: :uuid, index: false,
        foreign_key: { on_delete: :cascade }
      table.string :state, null: false, default: "Active"
      table.timestamps
    end
    add_index :channel_principals, :account_id, unique: true
    add_check_constraint :channel_principals, "principal_type = 'Account'",
      name: "channel_principals_type"
    add_check_constraint :channel_principals, "state IN ('Active', 'Revoked')",
      name: "channel_principals_state"

    create_table :channel_authenticators, id: :uuid do |table|
      table.references :channel_principal, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.string :authenticator_type, null: false
      table.string :password_digest, null: false
      table.datetime :last_used_at
      table.datetime :revoked_at
      table.timestamps
    end
    add_index :channel_authenticators, :channel_principal_id, unique: true,
      where: "authenticator_type = 'Password' AND revoked_at IS NULL",
      name: "index_one_active_password_authenticator"
    add_check_constraint :channel_authenticators, "authenticator_type = 'Password'",
      name: "channel_authenticators_type"
    add_check_constraint :channel_authenticators, "char_length(password_digest) > 0",
      name: "channel_authenticators_password_digest"
  end

  def create_sessions
    create_table :browser_sessions, id: :uuid do |table|
      table.references :channel_principal, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.string :client_family, null: false
      table.datetime :last_activity_at, null: false
      table.timestamps
    end
    add_index :browser_sessions, [ :channel_principal_id, :last_activity_at ]
    add_check_constraint :browser_sessions, "client_family IN ('Chrome', 'Firefox', 'Other')",
      name: "browser_sessions_client_family"

    create_table :api_sessions, id: :uuid do |table|
      table.references :channel_principal, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.datetime :confirmed_at, null: false
      table.datetime :revoked_at
      table.timestamps
    end

    create_table :session_credentials, id: :uuid do |table|
      table.references :api_session, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
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
      name: "session_credentials_secret_digest"
  end

  def create_hosted_replicas
    create_table :hosted_replicas, id: :uuid do |table|
      table.string :state, null: false, default: "Active"
      table.string :management_label
      table.bigint :quota_bytes
      table.bigint :stored_bytes, null: false, default: 0
      table.bigint :inventory_cursor, null: false, default: 0
      table.bigint :hint_cursor, null: false, default: 0
      table.timestamps
    end
    add_check_constraint :hosted_replicas, "state IN ('Active', 'Reaping')",
      name: "hosted_replicas_state"
    add_check_constraint :hosted_replicas,
      "management_label IS NULL OR char_length(management_label) BETWEEN 1 AND 80",
      name: "hosted_replicas_management_label"
    add_check_constraint :hosted_replicas,
      "quota_bytes IS NULL OR quota_bytes > 0",
      name: "hosted_replicas_quota"
    add_check_constraint :hosted_replicas,
      "stored_bytes >= 0 AND (quota_bytes IS NULL OR stored_bytes <= quota_bytes)",
      name: "hosted_replicas_stored_bytes"
    add_check_constraint :hosted_replicas,
      "inventory_cursor >= 0 AND hint_cursor >= 0",
      name: "hosted_replicas_cursors"
  end

  def create_replica_access_grants
    create_table :replica_access_grants, id: :uuid do |table|
      table.references :hosted_replica, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.references :channel_principal, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.string :capabilities, null: false, array: true, default: []
      table.string :grantable_capabilities, null: false, array: true, default: []
      table.uuid :created_by_grant_id
      table.datetime :revoked_at
      table.timestamps
    end
    add_foreign_key :replica_access_grants, :replica_access_grants,
      column: :created_by_grant_id, on_delete: :restrict
    add_index :replica_access_grants, [ :hosted_replica_id, :channel_principal_id ], unique: true,
      where: "revoked_at IS NULL", name: "index_one_active_grant_per_principal_and_replica"
    allowed = "ARRAY[#{REPLICA_CAPABILITIES.map { |value| connection.quote(value) }.join(", ")}]::varchar[]"
    add_check_constraint :replica_access_grants,
      "cardinality(capabilities) > 0 AND capabilities <@ #{allowed}",
      name: "replica_access_grants_capabilities"
    add_check_constraint :replica_access_grants,
      "grantable_capabilities <@ capabilities",
      name: "replica_access_grants_grantable_capabilities"
    add_check_constraint :replica_access_grants,
      "cardinality(grantable_capabilities) = 0 OR " \
      "'awsm.replica.manage' = ANY(capabilities)",
      name: "replica_access_grants_delegation_requires_manage"
  end

  def create_opaque_storage
    create_table :opaque_storage_items, id: :uuid do |table|
      table.references :hosted_replica, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.references :admitted_by_grant, type: :uuid,
        foreign_key: { to_table: :replica_access_grants, on_delete: :nullify }
      table.binary :storage_item_id, null: false
      table.string :storage_class, null: false
      table.bigint :byte_length, null: false
      table.binary :ciphertext_digest, null: false
      table.string :storage_key, null: false
      table.bigint :inventory_cursor, null: false
      table.timestamps
    end
    add_index :opaque_storage_items, [ :hosted_replica_id, :storage_item_id ], unique: true,
      name: "index_opaque_items_on_replica_and_item"
    add_index :opaque_storage_items, [ :hosted_replica_id, :inventory_cursor ], unique: true,
      name: "index_opaque_items_on_replica_and_cursor"
    add_index :opaque_storage_items, :storage_key, unique: true
    add_check_constraint :opaque_storage_items, "octet_length(storage_item_id) = 32",
      name: "opaque_storage_items_identity"
    add_check_constraint :opaque_storage_items, "storage_class IN ('Compact', 'Streamable')",
      name: "opaque_storage_items_class"
    add_check_constraint :opaque_storage_items, "byte_length > 0 AND inventory_cursor > 0",
      name: "opaque_storage_items_bounds"
    add_check_constraint :opaque_storage_items, "octet_length(ciphertext_digest) = 32",
      name: "opaque_storage_items_digest"

    create_table :opaque_uploads, id: :uuid do |table|
      table.references :hosted_replica, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.references :replica_access_grant, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.binary :storage_item_id, null: false
      table.bigint :byte_length, null: false
      table.binary :ciphertext_digest, null: false
      table.bigint :accepted_offset, null: false, default: 0
      table.binary :transfer_capability_digest, null: false
      table.datetime :transfer_capability_expires_at, null: false
      table.string :state, null: false, default: "Preparing"
      table.datetime :expires_at, null: false
      table.timestamps
    end
    add_check_constraint :opaque_uploads, "octet_length(storage_item_id) = 32",
      name: "opaque_uploads_identity"
    add_check_constraint :opaque_uploads, "octet_length(ciphertext_digest) = 32",
      name: "opaque_uploads_digest"
    add_check_constraint :opaque_uploads, "octet_length(transfer_capability_digest) = 32",
      name: "opaque_uploads_capability_digest"
    add_check_constraint :opaque_uploads,
      "byte_length > 0 AND accepted_offset >= 0 AND accepted_offset <= byte_length",
      name: "opaque_uploads_bounds"
    add_check_constraint :opaque_uploads, "state IN ('Preparing', 'Promoting')",
      name: "opaque_uploads_state"

    create_table :opaque_upload_parts, id: :uuid do |table|
      table.references :opaque_upload, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.integer :part_number, null: false
      table.bigint :start_offset, null: false
      table.bigint :byte_length, null: false
      table.binary :sha256, null: false
      table.string :storage_key, null: false
      table.timestamps
    end
    add_index :opaque_upload_parts, [ :opaque_upload_id, :part_number ], unique: true
    add_index :opaque_upload_parts, [ :opaque_upload_id, :start_offset ], unique: true
    add_index :opaque_upload_parts, :storage_key, unique: true
    add_check_constraint :opaque_upload_parts,
      "part_number >= 0 AND start_offset >= 0 AND byte_length > 0",
      name: "opaque_upload_parts_bounds"
    add_check_constraint :opaque_upload_parts, "octet_length(sha256) = 32",
      name: "opaque_upload_parts_digest"
  end

  def create_idempotency_records
    create_table :idempotency_records, id: :uuid do |table|
      table.references :channel_principal, null: false, type: :uuid,
        foreign_key: { on_delete: :cascade }
      table.string :operation, null: false
      table.uuid :idempotency_key, null: false
      table.string :http_method, null: false
      table.string :canonical_path, null: false
      table.binary :request_sha256, null: false
      table.string :status, null: false
      table.string :resource_type
      table.uuid :resource_id
      table.timestamps
    end
    add_index :idempotency_records,
      [ :channel_principal_id, :operation, :idempotency_key ], unique: true,
      name: "index_idempotency_on_principal_operation_key"
    add_check_constraint :idempotency_records, "octet_length(request_sha256) = 32",
      name: "idempotency_records_request_sha256"
    add_check_constraint :idempotency_records, "status IN ('InProgress', 'Succeeded')",
      name: "idempotency_records_status"
  end

  def create_lifecycle_jobs
    create_table :account_deletion_jobs, id: :uuid do |table|
      table.references :account, type: :uuid, foreign_key: { on_delete: :nullify }
      table.string :reason, null: false
      table.string :state, null: false
      table.string :stage, null: false
      table.bigint :total_bytes, null: false, default: 0
      table.bigint :processed_bytes, null: false, default: 0
      table.integer :retry_count, null: false, default: 0
      table.binary :receipt_digest
      table.datetime :receipt_expires_at
      table.datetime :started_at
      table.datetime :completed_at
      table.string :error_outcome
      table.timestamps
    end
    add_index :account_deletion_jobs, :account_id, unique: true,
      where: "account_id IS NOT NULL AND state <> 'Succeeded'",
      name: "index_one_active_account_deletion"
    add_check_constraint :account_deletion_jobs,
      "reason IN ('Manual', 'Inactivity')", name: "account_deletion_jobs_reason"
    add_check_constraint :account_deletion_jobs,
      "state IN ('Pending', 'Running', 'FailedRetryable', 'Succeeded')",
      name: "account_deletion_jobs_state"
    add_check_constraint :account_deletion_jobs,
      "stage IN ('Freeze', 'RevokeAccess', 'ReapReplicas', 'DeleteIdentity', 'Complete')",
      name: "account_deletion_jobs_stage"
    add_check_constraint :account_deletion_jobs,
      "total_bytes >= 0 AND processed_bytes >= 0 AND processed_bytes <= total_bytes AND retry_count >= 0",
      name: "account_deletion_jobs_counters"
    add_check_constraint :account_deletion_jobs,
      "receipt_digest IS NULL OR octet_length(receipt_digest) = 32",
      name: "account_deletion_jobs_receipt_digest"

    create_table :hosted_replica_reaping_jobs, id: :uuid do |table|
      table.references :hosted_replica, type: :uuid, foreign_key: { on_delete: :nullify }
      table.references :account_deletion_job, type: :uuid, foreign_key: { on_delete: :cascade }
      table.string :reason, null: false
      table.string :state, null: false
      table.string :stage, null: false
      table.bigint :total_bytes, null: false, default: 0
      table.bigint :processed_bytes, null: false, default: 0
      table.integer :retry_count, null: false, default: 0
      table.datetime :started_at
      table.datetime :completed_at
      table.string :error_outcome
      table.timestamps
    end
    add_index :hosted_replica_reaping_jobs, :hosted_replica_id, unique: true,
      where: "hosted_replica_id IS NOT NULL AND state <> 'Succeeded'",
      name: "index_one_active_hosted_replica_reaping"
    add_check_constraint :hosted_replica_reaping_jobs,
      "reason IN ('Manual', 'NoActiveGrants', 'AccountDeletion')",
      name: "hosted_replica_reaping_jobs_reason"
    add_check_constraint :hosted_replica_reaping_jobs,
      "state IN ('Pending', 'Running', 'FailedRetryable', 'Succeeded')",
      name: "hosted_replica_reaping_jobs_state"
    add_check_constraint :hosted_replica_reaping_jobs,
      "stage IN ('Freeze', 'DeleteOpaqueBytes', 'DeletePolicy', 'Complete')",
      name: "hosted_replica_reaping_jobs_stage"
    add_check_constraint :hosted_replica_reaping_jobs,
      "total_bytes >= 0 AND processed_bytes >= 0 AND processed_bytes <= total_bytes AND retry_count >= 0",
      name: "hosted_replica_reaping_jobs_counters"
  end
end
