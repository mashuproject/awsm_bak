class VaultDevice < ApplicationRecord
  self.primary_key = :device_id

  CLIENT_KINDS = %w[ChromeExtension FirefoxExtension].freeze
  REVOCATION_REASONS = %w[Removed FutureProtection VaultReencrypted].freeze

  belongs_to :vault_replica
  belongs_to :recovery_generation
  has_many :api_sessions, dependent: :destroy
  has_many :device_key_envelopes, dependent: :restrict_with_exception

  validates :certificate_id, presence: true, uniqueness: true
  validates :display_name, presence: true, length: { maximum: 64 }
  validates :client_kind, inclusion: { in: CLIENT_KINDS }
  validates :signing_algorithm, inclusion: { in: [ "sign:ed25519:device:v1" ] }
  validates :signing_public_key, length: { is: 32 }
  validates :wrapping_algorithm,
    inclusion: { in: [ "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1" ] }
  validates :wrapping_public_key, length: { is: 32 }
  validates :certificate_signature, length: { is: 64 }
  validates :enrolled_at, presence: true
  validates :revocation_reason, inclusion: { in: REVOCATION_REASONS }, allow_nil: true
  validate :revocation_is_consistent

  def active?
    revoked_at.nil?
  end

  def revoked?
    !active?
  end

  private

  def revocation_is_consistent
    valid = (revoked_at.nil? && revocation_reason.nil?) ||
      (revoked_at.present? && revocation_reason.present?)
    errors.add(:revocation_reason, :invalid) unless valid
  end
end
