class Account < ApplicationRecord
  USERNAME_PATTERN = /\A[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?\z/
  STATES = %w[Active Deleting].freeze

  has_secure_password

  has_many :vault_replicas, dependent: :restrict_with_exception
  has_many :browser_sessions, dependent: :destroy
  has_many :api_sessions, dependent: :destroy
  has_many :transfer_tickets, dependent: :destroy
  has_many :account_deletion_jobs, dependent: :nullify

  normalizes :username, with: ->(username) { username.to_s.strip.downcase(:ascii) }

  validates :username, presence: true, uniqueness: true,
    format: { with: USERNAME_PATTERN }, length: { in: 3..32 }
  validates :state, inclusion: { in: STATES }
  validates :last_activity_at, presence: true

  def active?
    state == "Active"
  end

  def revoke_all_sessions!(at: Time.current)
    transaction do
      browser_sessions.delete_all
      api_sessions.find_each { |session| session.revoke!(at:) }
    end
  end
end
