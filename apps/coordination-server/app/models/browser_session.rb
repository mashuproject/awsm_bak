class BrowserSession < ApplicationRecord
  CLIENT_FAMILIES = %w[Chrome Firefox Other].freeze

  belongs_to :account

  validates :client_family, inclusion: { in: CLIENT_FAMILIES }
  validates :last_activity_at, presence: true
end
