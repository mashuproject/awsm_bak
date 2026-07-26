require "digest"
require "openssl"

module Coordination
  class DeviceKeyEnvelope
    WIRE_FIELDS = %w[
      metadata ciphertext ciphertextSha256 administratorSignature
    ].freeze
    METADATA_FIELDS = %w[
      version vaultId recoveryGenerationId keyEpochId deviceId algorithm ephemeralPublicKey nonce
      ciphertextLength
    ].freeze
    UUID_PATTERN = /\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

    class << self
      def decode!(value, expected_vault_id:, expected_recovery_generation_id:,
        expected_key_epoch_id:, expected_device_id:, expected_administrator_public_key:)
        raise ArgumentError unless value.is_a?(Hash) && value.keys.sort == WIRE_FIELDS.sort
        metadata_cbor = ProtocolEncoding.decode_base64url(value.fetch("metadata"), bytes: 1..)
        metadata = CanonicalCbor.decode(metadata_cbor)
        validate_metadata!(
          metadata,
          expected_vault_id:,
          expected_recovery_generation_id:,
          expected_key_epoch_id:,
          expected_device_id:
        )

        ciphertext = ProtocolEncoding.decode_base64url(
          value.fetch("ciphertext"), bytes: metadata.fetch("ciphertextLength")
        )
        ciphertext_sha256 = ProtocolEncoding.decode_base64url(
          value.fetch("ciphertextSha256"), bytes: 32
        )
        raise ArgumentError unless ActiveSupport::SecurityUtils.secure_compare(
          Digest::SHA256.digest(ciphertext), ciphertext_sha256
        )
        administrator_signature = ProtocolEncoding.decode_base64url(
          value.fetch("administratorSignature"), bytes: 64
        )
        signed_metadata = CanonicalCbor.encode(
          "metadata" => metadata,
          "ciphertextSha256" => ciphertext_sha256
        )
        key = OpenSSL::PKey.new_raw_public_key("ED25519", expected_administrator_public_key)
        raise ArgumentError unless key.verify(nil, administrator_signature, signed_metadata)

        {
          vault_device_id: metadata.fetch("deviceId"),
          vault_key_epoch_id: metadata.fetch("keyEpochId"),
          recovery_generation_id: metadata.fetch("recoveryGenerationId"),
          algorithm: metadata.fetch("algorithm"),
          ephemeral_public_key: metadata.fetch("ephemeralPublicKey"),
          nonce: metadata.fetch("nonce"),
          ciphertext:,
          ciphertext_sha256:,
          signed_metadata:,
          administrator_signature:
        }
      rescue KeyError, ArgumentError, TypeError, OpenSSL::PKey::PKeyError
        raise OutcomeError.new("DEVICE_ENROLLMENT_INVALID", status: :unprocessable_content)
      end

      private

      def validate_metadata!(metadata, expected_vault_id:, expected_recovery_generation_id:,
        expected_key_epoch_id:, expected_device_id:)
        raise ArgumentError unless metadata.is_a?(Hash) && metadata.keys.sort == METADATA_FIELDS.sort
        raise ArgumentError unless metadata.fetch("version") == 1
        {
          "vaultId" => expected_vault_id,
          "recoveryGenerationId" => expected_recovery_generation_id,
          "keyEpochId" => expected_key_epoch_id,
          "deviceId" => expected_device_id
        }.each do |field, expected|
          value = metadata.fetch(field)
          raise ArgumentError unless value.is_a?(String) && value.match?(UUID_PATTERN) &&
            value == expected
        end
        raise ArgumentError unless metadata.fetch("algorithm") ==
          ::DeviceKeyEnvelope::ALGORITHM
        raise ArgumentError unless metadata.fetch("ephemeralPublicKey").is_a?(String) &&
          metadata.fetch("ephemeralPublicKey").bytesize == 32
        raise ArgumentError unless metadata.fetch("nonce").is_a?(String) &&
          metadata.fetch("nonce").bytesize == 24
        raise ArgumentError unless metadata.fetch("ciphertextLength") == 48
      end
    end
  end
end
