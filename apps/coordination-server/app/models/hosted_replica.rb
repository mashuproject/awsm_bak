class HostedReplica < ApplicationRecord
  STATES = %w[Active Reaping].freeze

  has_many :replica_access_grants, dependent: :destroy
  has_many :channel_principals, -> { distinct }, through: :replica_access_grants
  has_many :accounts, -> { distinct }, through: :channel_principals
  has_many :opaque_storage_items, dependent: :destroy
  has_many :opaque_uploads, dependent: :destroy
  has_many :hosted_replica_reaping_jobs, dependent: :nullify

  before_validation :generate_locator_salt, on: :create

  validates :state, inclusion: { in: STATES }
  validates :locator_salt, length: { is: 32 }
  validates :management_label, length: { in: 1..80 }, allow_nil: true
  validates :quota_bytes, numericality: { only_integer: true, greater_than: 0 }, allow_nil: true
  validates :stored_bytes, :inventory_cursor, :hint_cursor,
    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validate :stored_bytes_fit_quota

  def active?
    state == "Active"
  end

  private

  def generate_locator_salt
    self.locator_salt ||= SecureRandom.random_bytes(32)
  end

  def stored_bytes_fit_quota
    return if quota_bytes.nil? || stored_bytes.nil? || stored_bytes <= quota_bytes

    errors.add(:stored_bytes, :less_than_or_equal_to, count: quota_bytes)
  end
end
