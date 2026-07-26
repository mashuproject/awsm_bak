require "json"
require "openssl"
require "securerandom"
require "base64"

module Coordination
  class DeviceSessionChallenges
    LIFETIME = 60.seconds
    DOMAIN = "awsm:device-session-challenge:v1"

    class << self
      def issue!(account_session:, account:, vault:, device:)
        expires_at = Time.current + LIFETIME
        stored = {
          "accountSessionId" => account_session.id,
          "accountId" => account.id,
          "vaultId" => vault.vault_id,
          "deviceId" => device.device_id
        }.to_json

        3.times do
          challenge = Base64.urlsafe_encode64(SecureRandom.random_bytes(32), padding: false)
          created = EphemeralCoordination.with_redis do |redis|
            redis.set(
              EphemeralCoordination.device_session_challenge_key(challenge),
              stored,
              nx: true,
              ex: LIFETIME.to_i
            )
          end
          return { challenge:, expires_at: } if created
        end

        unavailable!
      rescue Redis::BaseError
        unavailable!
      end

      def consume_and_verify!(challenge:, signature:, account_session:, account:, vault:, device:)
        challenge_bytes = validate_challenge!(challenge)
        stored = EphemeralCoordination.with_redis do |redis|
          redis.getdel(EphemeralCoordination.device_session_challenge_key(challenge))
        end
        authentication_failed! unless stored
        binding = JSON.parse(stored)
        expected = {
          "accountSessionId" => account_session.id,
          "accountId" => account.id,
          "vaultId" => vault.vault_id,
          "deviceId" => device.device_id
        }
        authentication_failed! unless binding == expected && device.active?

        signature_bytes = ProtocolEncoding.decode_base64url(signature, bytes: 64)
        transcript = CanonicalCbor.encode(
          "domain" => DOMAIN,
          "accountSessionId" => account_session.id,
          "vaultId" => vault.vault_id,
          "deviceId" => device.device_id,
          "challenge" => challenge_bytes
        )
        key = OpenSSL::PKey.new_raw_public_key("ED25519", device.signing_public_key)
        authentication_failed! unless key.verify(nil, signature_bytes, transcript)

        true
      rescue Redis::BaseError
        unavailable!
      rescue JSON::ParserError, ArgumentError, TypeError, OpenSSL::PKey::PKeyError
        authentication_failed!
      end

      private

      def validate_challenge!(challenge)
        ProtocolEncoding.decode_base64url(challenge, bytes: 32)
      end

      def authentication_failed!
        raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
      end

      def unavailable!
        raise OutcomeError.new("AUTHENTICATION_UNAVAILABLE", status: :service_unavailable,
          retryable: true)
      end
    end
  end
end
