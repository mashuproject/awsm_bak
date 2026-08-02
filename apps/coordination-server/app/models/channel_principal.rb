class ChannelPrincipal < ApplicationRecord
  TYPES = %w[Account].freeze
  STATES = %w[Active Revoked].freeze

  belongs_to :account
  has_many :channel_authenticators, dependent: :destroy
  has_one :password_authenticator, -> { where(authenticator_type: "Password", revoked_at: nil) },
    class_name: "ChannelAuthenticator"
  has_many :browser_sessions, dependent: :destroy
  has_many :api_sessions, dependent: :destroy
  has_many :replica_access_grants, dependent: :destroy
  has_many :hosted_replicas, -> { distinct }, through: :replica_access_grants

  validates :principal_type, inclusion: { in: TYPES }
  validates :state, inclusion: { in: STATES }
  validates :account_id, uniqueness: true

  def active?
    state == "Active"
  end
end
