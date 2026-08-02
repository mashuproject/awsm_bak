class OpaqueUpload < ApplicationRecord
  STATES = %w[Preparing Promoting].freeze

  belongs_to :hosted_replica
  belongs_to :replica_access_grant
  has_many :opaque_upload_parts, dependent: :destroy

  validates :storage_item_id, :ciphertext_digest, :transfer_capability_digest, length: { is: 32 }
  validates :byte_length, numericality: { only_integer: true, greater_than: 0 }
  validates :accepted_offset, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :state, inclusion: { in: STATES }
  validates :expires_at, :transfer_capability_expires_at, presence: true
  validate :accepted_offset_within_length

  private

  def accepted_offset_within_length
    return if accepted_offset.nil? || byte_length.nil? || accepted_offset <= byte_length

    errors.add(:accepted_offset, :less_than_or_equal_to, count: byte_length)
  end
end
