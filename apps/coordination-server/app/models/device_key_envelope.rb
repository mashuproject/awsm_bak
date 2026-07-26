class DeviceKeyEnvelope < ApplicationRecord
  ALGORITHM = "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1"

  belongs_to :vault_device
  belongs_to :vault_key_epoch
  belongs_to :recovery_generation

  validates :algorithm, inclusion: { in: [ ALGORITHM ] }
  validates :ephemeral_public_key, length: { is: 32 }
  validates :nonce, length: { is: 24 }
  validates :ciphertext, length: { is: 48 }
  validates :ciphertext_sha256, length: { is: 32 }
  validates :administrator_signature, length: { is: 64 }
  validates :vault_key_epoch_id, uniqueness: { scope: :vault_device_id }
end
