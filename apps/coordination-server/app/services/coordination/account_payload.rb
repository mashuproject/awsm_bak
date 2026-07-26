module Coordination
  class AccountPayload
    class << self
      def response(account:, issued:)
        {
          account: {
            accountId: account.id,
            email: account.email
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
