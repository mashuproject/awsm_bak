class SessionCredential < ApplicationRecord
  KINDS = %w[Access Refresh].freeze

  belongs_to :api_session

  validates :kind, inclusion: { in: KINDS }
  validates :secret_digest, length: { is: 32 }
  validates :expires_at, presence: true

  def usable?(at: Time.current)
    revoked_at.nil? && consumed_at.nil? && expires_at > at && api_session.active?
  end
end
