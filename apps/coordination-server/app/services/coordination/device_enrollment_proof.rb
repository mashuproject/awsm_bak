require "digest"
require "openssl"

module Coordination
  class DeviceEnrollmentProof
    DOMAIN = "awsm:device-enrollment-proof:v1"
    UUID_PATTERN = /\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

    class << self
      def verify!(value, certificate_cbor:, certificate_signature:, signing_public_key:,
        account_session_id:)
        raise ArgumentError unless account_session_id.is_a?(String) &&
          account_session_id.match?(UUID_PATTERN)
        raise ArgumentError unless certificate_signature.bytesize == 64 &&
          signing_public_key.bytesize == 32
        signature = ProtocolEncoding.decode_base64url(value, bytes: 64)
        transcript = CanonicalCbor.encode(
          "domain" => DOMAIN,
          "certificateSha256" => Digest::SHA256.digest(certificate_cbor),
          "certificateSignatureSha256" => Digest::SHA256.digest(certificate_signature),
          "accountSessionId" => account_session_id
        )
        key = OpenSSL::PKey.new_raw_public_key("ED25519", signing_public_key)
        raise ArgumentError unless key.verify(nil, signature, transcript)

        true
      rescue ArgumentError, TypeError, OpenSSL::PKey::PKeyError
        raise OutcomeError.new("DEVICE_ENROLLMENT_INVALID", status: :unprocessable_content)
      end
    end
  end
end
