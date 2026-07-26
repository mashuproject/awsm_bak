class Current < ActiveSupport::CurrentAttributes
  attribute :browser_session
  delegate :account, to: :browser_session, allow_nil: true
end
