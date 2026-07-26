class VaultReplica < ApplicationRecord
  STATES = %w[Provisional Active Replaced].freeze

  belongs_to :account
  belongs_to :active_generation, class_name: "VaultGeneration", optional: true
  belongs_to :active_key_epoch, class_name: "VaultKeyEpoch", optional: true
  belongs_to :active_recovery_generation, class_name: "RecoveryGeneration", optional: true
  has_many :opaque_records, dependent: :restrict_with_exception
  has_many :vault_generations, dependent: :restrict_with_exception
  has_many :recovery_generations, dependent: :restrict_with_exception
  has_many :vault_key_epochs, dependent: :restrict_with_exception
  has_many :vault_devices, dependent: :restrict_with_exception
  has_many :delivery_changes, dependent: :restrict_with_exception
  has_many :purge_jobs, dependent: :restrict_with_exception
  has_many :transfer_tickets, dependent: :restrict_with_exception

  validates :vault_id, presence: true, uniqueness: true
  validates :state, inclusion: { in: STATES }
  validates :head_cursor, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
end
