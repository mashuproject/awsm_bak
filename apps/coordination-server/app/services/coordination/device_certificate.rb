require "openssl"
require "time"

module Coordination
  class DeviceCertificate
    FIELDS = %w[
      version certificateId vaultId recoveryGenerationId deviceId displayName clientKind
      signingAlgorithm signingPublicKey wrappingAlgorithm wrappingPublicKey issuedAt
    ].freeze
    CLIENT_KINDS = %w[ChromeExtension FirefoxExtension].freeze
    UUID_PATTERN = /\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

    class << self
      def decode!(value, expected_vault_id:, expected_recovery_generation_id:,
        expected_administrator_public_key:, now: Time.current)
        content_cbor = ProtocolEncoding.decode_base64url(value.fetch("content"), bytes: 1..)
        administrator_public_key = ProtocolEncoding.decode_base64url(
          value.fetch("recoveryAdministratorPublicKey"), bytes: 32
        )
        signature = ProtocolEncoding.decode_base64url(value.fetch("signature"), bytes: 64)
        content = CanonicalCbor.decode(content_cbor)
        validate_content!(content, expected_vault_id:, expected_recovery_generation_id:, now:)
        secure_equal!(administrator_public_key, expected_administrator_public_key)
        key = OpenSSL::PKey.new_raw_public_key("ED25519", administrator_public_key)
        raise ArgumentError unless key.verify(nil, signature, content_cbor)

        {
          certificate_id: content.fetch("certificateId"),
          vault_id: content.fetch("vaultId"),
          recovery_generation_id: content.fetch("recoveryGenerationId"),
          device_id: content.fetch("deviceId"),
          display_name: content.fetch("displayName"),
          client_kind: content.fetch("clientKind"),
          signing_algorithm: content.fetch("signingAlgorithm"),
          signing_public_key: content.fetch("signingPublicKey"),
          wrapping_algorithm: content.fetch("wrappingAlgorithm"),
          wrapping_public_key: content.fetch("wrappingPublicKey"),
          issued_at: Time.iso8601(content.fetch("issuedAt")),
          certificate_cbor: content_cbor,
          certificate_signature: signature
        }
      rescue KeyError, ArgumentError, OpenSSL::PKey::PKeyError
        raise OutcomeError.new("DEVICE_ENROLLMENT_INVALID", status: :unprocessable_content)
      end

      private

      def validate_content!(content, expected_vault_id:, expected_recovery_generation_id:, now:)
        raise ArgumentError unless content.is_a?(Hash) && content.keys.sort == FIELDS.sort
        raise ArgumentError unless content.fetch("version") == 1
        %w[certificateId vaultId recoveryGenerationId deviceId].each do |field|
          raise ArgumentError unless content.fetch(field).match?(UUID_PATTERN)
        end
        raise ArgumentError unless content.fetch("vaultId") == expected_vault_id
        raise ArgumentError unless content.fetch("recoveryGenerationId") ==
          expected_recovery_generation_id
        display_name = content.fetch("displayName")
        raise ArgumentError unless display_name.is_a?(String) && display_name == display_name.strip &&
          display_name.each_char.count.between?(1, 64)
        raise ArgumentError unless CLIENT_KINDS.include?(content.fetch("clientKind"))
        raise ArgumentError unless content.fetch("signingAlgorithm") == "sign:ed25519:device:v1"
        raise ArgumentError unless content.fetch("signingPublicKey").is_a?(String) &&
          content.fetch("signingPublicKey").bytesize == 32
        raise ArgumentError unless content.fetch("wrappingAlgorithm") ==
          "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1"
        raise ArgumentError unless content.fetch("wrappingPublicKey").is_a?(String) &&
          content.fetch("wrappingPublicKey").bytesize == 32
        issued_at = Time.iso8601(content.fetch("issuedAt"))
        raise ArgumentError unless issued_at.utc.iso8601(3) == content.fetch("issuedAt")
        raise ArgumentError if issued_at > now + 5.minutes
      end

      def secure_equal!(left, right)
        raise ArgumentError unless left.bytesize == right.bytesize &&
          ActiveSupport::SecurityUtils.secure_compare(left, right)
      end
    end
  end
end
