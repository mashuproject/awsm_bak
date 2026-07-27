module Coordination
  class AccountPayload
    class << self
      def response(account:, issued:)
        {
          account: {
            accountId: account.id,
            username: account.username,
            inactiveDeletionAt: (
              account.last_activity_at +
              ServicePolicy.current.inactive_account_retention_days.days
            ).iso8601(3)
          },
          sessionId: issued.fetch(:session).id,
          scope: issued.fetch(:session).scope,
          accessToken: issued.fetch(:access_token),
          accessExpiresAt: issued.fetch(:access_expires_at).iso8601(3),
          refreshToken: issued.fetch(:refresh_token),
          refreshExpiresAt: issued.fetch(:refresh_expires_at).iso8601(3)
        }
      end
    end
  end
end
