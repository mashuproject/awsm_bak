class ReplicaAccessGrant < ApplicationRecord
  CAPABILITIES = %w[
    awsm.replica.hint.read
    awsm.replica.hint.write
    awsm.replica.inventory.read
    awsm.replica.item.read
    awsm.replica.item.write
    awsm.replica.manage
  ].freeze

  belongs_to :hosted_replica
  belongs_to :channel_principal
  belongs_to :created_by_grant, class_name: "ReplicaAccessGrant", optional: true
  has_many :issued_grants, class_name: "ReplicaAccessGrant", foreign_key: :created_by_grant_id,
    dependent: :restrict_with_exception, inverse_of: :created_by_grant

  before_validation :normalize_capabilities

  validates :capabilities, length: { minimum: 1 }
  validate :capability_sets_are_valid
  validates :channel_principal_id, uniqueness: {
    scope: :hosted_replica_id,
    conditions: -> { where(revoked_at: nil) }
  }, if: -> { revoked_at.nil? }
  validate :portable_fields_are_immutable, on: :update
  validate :revocation_is_terminal, on: :update

  def active?
    revoked_at.nil?
  end

  def permits?(capability)
    active? && capabilities.include?(capability)
  end

  private

  def normalize_capabilities
    self.capabilities = Array(capabilities).uniq.sort
    self.grantable_capabilities = Array(grantable_capabilities).uniq.sort
  end

  def capability_sets_are_valid
    errors.add(:capabilities, :invalid) unless capabilities.all? { |value| CAPABILITIES.include?(value) }
    return if grantable_capabilities.all? { |value| capabilities.include?(value) }

    errors.add(:grantable_capabilities, :invalid)
  end

  def portable_fields_are_immutable
    fields = %w[hosted_replica_id channel_principal_id capabilities grantable_capabilities created_by_grant_id]
    errors.add(:base, "Replica Access Grant is immutable") if changes.keys.intersect?(fields)
  end

  def revocation_is_terminal
    errors.add(:revoked_at, "cannot be cleared") if revoked_at_was.present? && revoked_at.nil?
  end
end
