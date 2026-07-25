class Account < ApplicationRecord
  KDF_OPERATIONS = 3
  KDF_MEMORY_BYTES = 67_108_864
  KEY_ENVELOPE_ALGORITHM = "wrap:xchacha20poly1305:account-password:v1"
  VAULT_SLOT_ALGORITHM = "wrap:xchacha20poly1305:account:v1"

  has_secure_password :authentication_secret

  has_many :vault_replicas, dependent: :restrict_with_exception
  has_many :account_sessions, dependent: :destroy
  has_many :signup_registrations, dependent: :destroy

  normalizes :email, with: ->(email) { email.to_s.strip.downcase }

  validates :email, presence: true, uniqueness: { case_sensitive: false },
    format: { with: /\A[^\s@]+@[^\s@]+\z/ }, length: { maximum: 254 }
  validates :account_key_id, presence: true, uniqueness: true
  validates :kdf_salt, length: { is: 16 }
  validates :kdf_operations, comparison: { equal_to: KDF_OPERATIONS }
  validates :kdf_memory_bytes, comparison: { equal_to: KDF_MEMORY_BYTES }
  validates :key_envelope_algorithm, inclusion: { in: [ KEY_ENVELOPE_ALGORITHM ] }
  validates :key_envelope_nonce, length: { is: 24 }
  validates :key_envelope_ciphertext, length: { minimum: 48 }
end
