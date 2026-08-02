class OpaqueStorageItem < ApplicationRecord
  STORAGE_CLASSES = %w[Compact Streamable].freeze

  belongs_to :hosted_replica
  belongs_to :admitted_by_grant, class_name: "ReplicaAccessGrant", optional: true

  validates :storage_item_id, :ciphertext_digest, length: { is: 32 }
  validates :storage_class, inclusion: { in: STORAGE_CLASSES }
  validates :byte_length, :inventory_cursor,
    numericality: { only_integer: true, greater_than: 0 }
  validates :storage_key, presence: true, uniqueness: true
  validates :storage_item_id, uniqueness: { scope: :hosted_replica_id }
  validates :inventory_cursor, uniqueness: { scope: :hosted_replica_id }
end
