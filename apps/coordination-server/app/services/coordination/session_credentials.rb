require "base64"
require "digest"
require "securerandom"

module Coordination
  class SessionCredentials
    ACCESS_LIFETIME = 15.minutes
    REFRESH_LIFETIME = 30.days

    class << self
      def issue(account:, scope: "Account", vault_device_id: nil, confirmed_at: Time.current)
        ApiSession.transaction do
          account.lock!
          authentication_failed! unless account.active?

          session = account.api_sessions.create!(scope:, vault_device_id:, confirmed_at:)
          tokens_for(session)
        end
      end

      def refresh(token)
        credential, secret = find(token, kind: "Refresh")
        now = Time.current
        SessionCredential.transaction do
          account = credential.api_session.account
          account.lock!
          authentication_failed! unless account.active?

          credential.lock!
          unless credential.usable?(at: now) && secure_equal?(credential.secret_digest, digest(secret))
            credential.api_session.revoke!(at: now) if credential.consumed_at.present?
            raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
          end
          credential.update!(consumed_at: now)
          tokens_for(credential.api_session, now:)
        end
      rescue ActiveRecord::RecordNotFound
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end

      def authenticate(token)
        credential, secret = find(token, kind: "Access")
        unless credential.usable? && secure_equal?(credential.secret_digest, digest(secret))
          authentication_failed!
        end
        authentication_failed! unless credential.api_session.account.active?

        credential.api_session
      rescue ActiveRecord::RecordNotFound
        authentication_failed!
      end

      private

      def tokens_for(session, now: Time.current)
        access_token, access = create(session, "Access", now + ACCESS_LIFETIME)
        refresh_token, refresh = create(session, "Refresh", now + REFRESH_LIFETIME)
        {
          session:,
          access_token:,
          access_expires_at: access.expires_at,
          refresh_token:,
          refresh_expires_at: refresh.expires_at
        }
      end

      def create(session, kind, expires_at)
        secret = SecureRandom.urlsafe_base64(32, padding: false)
        credential = session.session_credentials.create!(kind:, secret_digest: digest(secret), expires_at:)
        [ "#{credential.id}.#{secret}", credential ]
      end

      def find(token, kind:)
        id, secret = token.to_s.split(".", 2)
        raise ActiveRecord::RecordNotFound if id.blank? || secret.blank?
        [ SessionCredential.includes(:api_session).find_by!(id:, kind:), secret ]
      end

      def digest(secret)
        Digest::SHA256.digest(secret)
      end

      def secure_equal?(left, right)
        left.bytesize == right.bytesize && ActiveSupport::SecurityUtils.secure_compare(left, right)
      end

      def authentication_failed!
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end
    end
  end
end
