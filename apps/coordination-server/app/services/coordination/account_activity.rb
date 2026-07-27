module Coordination
  class AccountActivity
    WRITE_INTERVAL = 24.hours

    class << self
      def touch!(account:, browser_session: nil, at: Time.current)
        Account.transaction do
          account.lock!
          authentication_failed! unless account.active?

          touch_record!(account, at:)
          if browser_session
            authentication_failed! unless browser_session.account_id == account.id
            browser_session.lock!
            touch_record!(browser_session, at:)
          end

          account.last_activity_at
        end
      end

      private

      def touch_record!(record, at:)
        return unless record.last_activity_at <= at - WRITE_INTERVAL

        record.update_columns(last_activity_at: at, updated_at: at)
      end

      def authentication_failed!
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end
    end
  end
end
