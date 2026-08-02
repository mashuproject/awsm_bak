module Coordination
  class AccountPayload
    class << self
      def response(account:, issued:)
        {
          account: {
            username: account.username,
            inactive_deletion_at: (
              account.last_activity_at +
              ServicePolicy.current.inactive_account_retention_days.days
            ).iso8601(3)
          },
          session_id: issued.fetch(:session).id,
          access_token: issued.fetch(:access_token),
          access_expires_at: issued.fetch(:access_expires_at).iso8601(3),
          refresh_token: issued.fetch(:refresh_token),
          refresh_expires_at: issued.fetch(:refresh_expires_at).iso8601(3)
        }
      end
    end
  end
end
