class ChannelAuthenticator < ApplicationRecord
  TYPES = %w[Password].freeze

  belongs_to :channel_principal
  has_secure_password

  validates :authenticator_type, inclusion: { in: TYPES }
  validates :authenticator_type, uniqueness: {
    scope: :channel_principal_id,
    conditions: -> { where(revoked_at: nil) }
  }

  def active?
    revoked_at.nil? && channel_principal.active?
  end
end
