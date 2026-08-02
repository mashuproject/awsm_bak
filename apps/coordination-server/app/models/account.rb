class Account < ApplicationRecord
  USERNAME_PATTERN = /\A[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?\z/
  STATES = %w[Active Deleting].freeze

  attr_reader :password
  attr_accessor :password_confirmation

  has_one :channel_principal, dependent: :destroy
  has_many :browser_sessions, through: :channel_principal
  has_many :api_sessions, through: :channel_principal
  has_many :replica_access_grants, through: :channel_principal
  has_many :hosted_replicas, -> { distinct }, through: :replica_access_grants
  has_many :account_deletion_jobs, dependent: :nullify

  normalizes :username, with: ->(username) { username.to_s.strip.downcase(:ascii) }

  validates :username, presence: true, uniqueness: true,
    format: { with: USERNAME_PATTERN }, length: { in: 3..32 }
  validates :state, inclusion: { in: STATES }
  validates :last_activity_at, presence: true
  validates :password, presence: true, confirmation: true, length: { maximum: 72 }, on: :create

  after_create :create_account_channel_identity!

  def password=(value)
    @password = value
  end

  def authenticate(candidate)
    authenticator = channel_principal&.password_authenticator
    return false unless active? && authenticator&.active?

    authenticator.authenticate(candidate) ? self : false
  end

  def active?
    state == "Active"
  end

  def revoke_all_sessions!(at: Time.current)
    transaction do
      channel_principal.browser_sessions.delete_all
      channel_principal.api_sessions.find_each { |session| session.revoke!(at:) }
    end
  end

  def replace_password!(password:, password_confirmation:, at: Time.current)
    transaction do
      principal = channel_principal.lock!
      current = principal.password_authenticator&.lock!
      raise ActiveRecord::RecordInvalid, self unless current&.active?

      replacement = principal.channel_authenticators.build(
        authenticator_type: "Password",
        password:,
        password_confirmation:
      )
      current.update!(revoked_at: at)
      replacement.save!
      revoke_all_sessions!(at:)
      replacement
    end
  end

  private

  def create_account_channel_identity!
    principal = create_channel_principal!(principal_type: "Account", state: "Active")
    principal.channel_authenticators.create!(
      authenticator_type: "Password",
      password:,
      password_confirmation:
    )
    @password = nil
    self.password_confirmation = nil
  end
end
