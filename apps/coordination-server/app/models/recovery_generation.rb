class RecoveryGeneration < ApplicationRecord
  DERIVATION_ALGORITHM = "kdf:hkdf-sha256:recovery-entropy:v1"
  WRAPPING_ALGORITHM = "wrap:xchacha20poly1305:recovery-kit:v1"
  SIGNING_ALGORITHM = "sign:ed25519:recovery-administrator:v1"

  belongs_to :vault_replica
  has_many :vault_key_epochs, dependent: :restrict_with_exception
  has_many :vault_devices, dependent: :restrict_with_exception
  has_many :device_key_envelopes, dependent: :restrict_with_exception

  validates :ordinal, numericality: { only_integer: true, greater_than_or_equal_to: 0 },
    uniqueness: { scope: :vault_replica_id }
  validates :derivation_algorithm, inclusion: { in: [ DERIVATION_ALGORITHM ] }
  validates :wrapping_algorithm, inclusion: { in: [ WRAPPING_ALGORITHM ] }
  validates :administrator_signing_algorithm, inclusion: { in: [ SIGNING_ALGORITHM ] }
  validates :administrator_public_key, length: { is: 32 }
  validates :kit_nonce, length: { is: 24 }
  validates :kit_ciphertext_sha256, length: { is: 32 }
  validates :kit_ciphertext_length, numericality: { only_integer: true, greater_than_or_equal_to: 16 }
  validate :ciphertext_matches_declared_length

  private

  def ciphertext_matches_declared_length
    return if kit_ciphertext.nil? && retired_at.present?
    errors.add(:kit_ciphertext, :invalid) unless kit_ciphertext&.bytesize == kit_ciphertext_length
  end
end
