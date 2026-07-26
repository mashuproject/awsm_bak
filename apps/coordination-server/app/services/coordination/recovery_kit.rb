require "digest"

module Coordination
  class RecoveryKit
    FIELDS = %w[
      version vaultId recoveryGenerationId derivationAlgorithm wrappingAlgorithm
      administratorSigningAlgorithm administratorPublicKey nonce ciphertextLength
      ciphertextSha256 ciphertext
    ].freeze
    UUID_PATTERN = /\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/
    MAX_SAFE_INTEGER = 9_007_199_254_740_991

    class << self
      def encode(recovery_generation)
        {
          version: 1,
          vaultId: recovery_generation.vault_replica.vault_id,
          recoveryGenerationId: recovery_generation.id,
          derivationAlgorithm: recovery_generation.derivation_algorithm,
          wrappingAlgorithm: recovery_generation.wrapping_algorithm,
          administratorSigningAlgorithm: recovery_generation.administrator_signing_algorithm,
          administratorPublicKey:
            ProtocolEncoding.encode_base64url(recovery_generation.administrator_public_key),
          nonce: ProtocolEncoding.encode_base64url(recovery_generation.kit_nonce),
          ciphertextLength: recovery_generation.kit_ciphertext_length,
          ciphertextSha256:
            ProtocolEncoding.encode_base64url(recovery_generation.kit_ciphertext_sha256),
          ciphertext: ProtocolEncoding.encode_base64url(recovery_generation.kit_ciphertext)
        }
      end

      def decode!(value, expected_vault_id:, expected_recovery_generation_id:)
        raise ArgumentError unless value.is_a?(Hash) && value.keys.sort == FIELDS.sort
        raise ArgumentError unless value.fetch("version") == 1

        vault_id = validated_uuid(value.fetch("vaultId"))
        recovery_generation_id = validated_uuid(value.fetch("recoveryGenerationId"))
        raise ArgumentError unless vault_id == expected_vault_id
        raise ArgumentError unless recovery_generation_id == expected_recovery_generation_id
        raise ArgumentError unless value.fetch("derivationAlgorithm") ==
          RecoveryGeneration::DERIVATION_ALGORITHM
        raise ArgumentError unless value.fetch("wrappingAlgorithm") ==
          RecoveryGeneration::WRAPPING_ALGORITHM
        raise ArgumentError unless value.fetch("administratorSigningAlgorithm") ==
          RecoveryGeneration::SIGNING_ALGORITHM

        administrator_public_key = ProtocolEncoding.decode_base64url(
          value.fetch("administratorPublicKey"), bytes: 32
        )
        kit_nonce = ProtocolEncoding.decode_base64url(value.fetch("nonce"), bytes: 24)
        kit_ciphertext_length = value.fetch("ciphertextLength")
        raise ArgumentError unless kit_ciphertext_length.is_a?(Integer) &&
          kit_ciphertext_length.between?(16, MAX_SAFE_INTEGER)
        kit_ciphertext_sha256 = ProtocolEncoding.decode_base64url(
          value.fetch("ciphertextSha256"), bytes: 32
        )
        kit_ciphertext = ProtocolEncoding.decode_base64url(
          value.fetch("ciphertext"), bytes: kit_ciphertext_length
        )
        actual_sha256 = Digest::SHA256.digest(kit_ciphertext)
        raise ArgumentError unless ActiveSupport::SecurityUtils.secure_compare(
          actual_sha256, kit_ciphertext_sha256
        )

        {
          vault_id:,
          recovery_generation_id:,
          derivation_algorithm: value.fetch("derivationAlgorithm"),
          wrapping_algorithm: value.fetch("wrappingAlgorithm"),
          administrator_signing_algorithm: value.fetch("administratorSigningAlgorithm"),
          administrator_public_key:,
          kit_nonce:,
          kit_ciphertext:,
          kit_ciphertext_length:,
          kit_ciphertext_sha256:
        }
      rescue KeyError, ArgumentError, TypeError
        raise OutcomeError.new("DEVICE_ENROLLMENT_INVALID", status: :unprocessable_content)
      end

      private

      def validated_uuid(value)
        raise ArgumentError unless value.is_a?(String) && value.match?(UUID_PATTERN)

        value
      end
    end
  end
end
