class ApiSession < ApplicationRecord
  SCOPES = %w[Account VaultDevice].freeze

  belongs_to :account
  belongs_to :vault_device, optional: true
  has_many :session_credentials, dependent: :destroy

  validates :scope, inclusion: { in: SCOPES }
  validates :confirmed_at, presence: true
  validate :scope_matches_vault_device

  def revoke!(at: Time.current)
    transaction do
      update!(revoked_at: at)
      session_credentials.where(revoked_at: nil).update_all(revoked_at: at, updated_at: at)
    end
  end

  def active?
    revoked_at.nil?
  end

  def revoked?
    !active?
  end

  private

  def scope_matches_vault_device
    valid = (scope == "Account" && vault_device_id.nil?) ||
      (scope == "VaultDevice" && vault_device_id.present?)
    errors.add(:vault_device_id, :invalid) unless valid
  end
end
