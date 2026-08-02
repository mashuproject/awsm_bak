module Coordination
  AccountPrincipal = Data.define(:account, :channel_principal, :confirmed_at, :session) do
    def initialize(account:, channel_principal: account.channel_principal, confirmed_at:, session: nil)
      super
    end
  end

  class AccountAuthenticator
    SYNTHETIC_AUTHENTICATION_DIGEST = BCrypt::Password.create(SecureRandom.base64(32)).to_s.freeze

    class << self
      def authenticate(request)
        authenticate_credential(bearer_credential(request))
      end

      def authenticate_credential(credential)
        raise OutcomeError.new("authentication_required", status: :unauthorized) if credential.nil?
        session = SessionCredentials.authenticate(credential)
        unless session.account.active?
          raise OutcomeError.new("authentication_required", status: :unauthorized)
        end

        AccountPrincipal.new(
          account: session.account,
          channel_principal: session.channel_principal,
          confirmed_at: session.confirmed_at,
          session:
        )
      end

      def authenticate_login(username, password)
        account = Account.find_by(username: Account.normalize_value_for(:username, username))
        authenticator = account&.channel_principal&.password_authenticator
        digest = authenticator&.password_digest || SYNTHETIC_AUTHENTICATION_DIGEST
        authenticated = BCrypt::Password.new(digest).is_password?(password)
        if authenticated && account&.active? && authenticator&.active?
          authenticator.update!(last_used_at: Time.current)
          return account
        end

        raise OutcomeError.new("authentication_required", status: :unauthorized)
      end

      private

      def bearer_credential(request)
        scheme, value = request.authorization.to_s.split(" ", 2)
        value if scheme == "Bearer" && value.present?
      end
    end
  end
end
