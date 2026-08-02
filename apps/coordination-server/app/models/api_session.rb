class ApiSession < ApplicationRecord
  belongs_to :channel_principal
  has_many :session_credentials, dependent: :destroy
  delegate :account, to: :channel_principal

  validates :confirmed_at, presence: true

  def revoke!(at: Time.current)
    transaction do
      update!(revoked_at: at)
      session_credentials.where(revoked_at: nil).update_all(revoked_at: at, updated_at: at)
    end
  end

  def active?
    revoked_at.nil? && channel_principal.active?
  end

  def revoked?
    !active?
  end
end
