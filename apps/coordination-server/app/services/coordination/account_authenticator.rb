module Coordination
  AccountPrincipal = Data.define(:account, :confirmed_at, :session, :scope) do
    def initialize(account:, confirmed_at:, session: nil, scope: "Account")
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
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized) if credential.nil?
        session = SessionCredentials.authenticate(credential)
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized) unless session.account.active?

        AccountPrincipal.new(account: session.account, confirmed_at: session.confirmed_at, session:,
          scope: session.scope)
      end

      def authenticate_login(username, password)
        account = Account.find_by(username: Account.normalize_value_for(:username, username))
        digest = account&.password_digest || SYNTHETIC_AUTHENTICATION_DIGEST
        authenticated = BCrypt::Password.new(digest).is_password?(password)
        return account if authenticated && account&.active?

        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end

      private

      def bearer_credential(request)
        scheme, value = request.authorization.to_s.split(" ", 2)
        value if scheme == "Bearer" && value.present?
      end
    end
  end
end
