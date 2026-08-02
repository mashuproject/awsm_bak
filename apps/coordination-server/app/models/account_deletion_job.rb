class AccountDeletionJob < ApplicationRecord
  REASONS = %w[Manual Inactivity].freeze
  STATES = %w[Pending Running FailedRetryable Succeeded].freeze
  STAGES = %w[Freeze RevokeAccess ReapReplicas DeleteIdentity Complete].freeze
  ERROR_OUTCOMES = %w[
    STORAGE_UNAVAILABLE
    DELETE_VERIFICATION_FAILED
    INTERNAL_RETRY
  ].freeze

  belongs_to :account, optional: true
  has_many :hosted_replica_reaping_jobs, dependent: :destroy

  validates :reason, inclusion: { in: REASONS }
  validates :state, inclusion: { in: STATES }
  validates :stage, inclusion: { in: STAGES }
  validates :total_bytes, :processed_bytes, :retry_count,
    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :receipt_digest, length: { is: 32 }, allow_nil: true
  validates :error_outcome, inclusion: { in: ERROR_OUTCOMES }, allow_nil: true

  def public_state
    state == "FailedRetryable" ? "Retrying" : state
  end
end
