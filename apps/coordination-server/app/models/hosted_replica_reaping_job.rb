class HostedReplicaReapingJob < ApplicationRecord
  REASONS = %w[Manual NoActiveGrants AccountDeletion].freeze
  STATES = %w[Pending Running FailedRetryable Succeeded].freeze
  STAGES = %w[Freeze DeleteOpaqueBytes DeletePolicy Complete].freeze
  ERROR_OUTCOMES = %w[ACTIVE_GRANT_PRESENT STORAGE_UNAVAILABLE DELETE_VERIFICATION_FAILED INTERNAL_RETRY].freeze

  belongs_to :hosted_replica, optional: true
  belongs_to :account_deletion_job, optional: true

  validates :reason, inclusion: { in: REASONS }
  validates :state, inclusion: { in: STATES }
  validates :stage, inclusion: { in: STAGES }
  validates :total_bytes, :processed_bytes, :retry_count,
    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :error_outcome, inclusion: { in: ERROR_OUTCOMES }, allow_nil: true
end
