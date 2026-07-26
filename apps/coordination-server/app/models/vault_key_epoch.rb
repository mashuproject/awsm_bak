class VaultKeyEpoch < ApplicationRecord
  self.table_name = "vault_key_epochs"

  belongs_to :vault_replica
  belongs_to :recovery_generation
  has_many :device_key_envelopes, dependent: :restrict_with_exception
  has_many :opaque_records, dependent: :restrict_with_exception

  validates :ordinal, numericality: { only_integer: true, greater_than_or_equal_to: 0 },
    uniqueness: { scope: :vault_replica_id }
end
