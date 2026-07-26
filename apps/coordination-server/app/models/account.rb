class Account < ApplicationRecord
  has_secure_password

  has_many :vault_replicas, dependent: :restrict_with_exception
  has_many :browser_sessions, dependent: :destroy
  has_many :api_sessions, dependent: :destroy

  normalizes :email, with: ->(email) { email.to_s.strip.downcase }

  validates :email, presence: true, uniqueness: { case_sensitive: false },
    format: { with: /\A[^\s@]+@[^\s@]+\z/ }, length: { maximum: 254 }

  def revoke_all_sessions!(at: Time.current)
    transaction do
      browser_sessions.delete_all
      api_sessions.find_each { |session| session.revoke!(at:) }
    end
  end
end
