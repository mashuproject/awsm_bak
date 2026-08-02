require "base64"

module Coordination
  module ProtocolEncoding
    module_function

    def decode_sha256(value)
      decoded = Base64.urlsafe_decode64(value.to_s)
      return decoded if decoded.bytesize == 32 && encode_sha256(decoded) == value

      raise ArgumentError
    rescue ArgumentError
      raise OutcomeError.new("protocol_invalid", status: :bad_request)
    end

    def encode_sha256(value)
      encode_base64url(value)
    end

    def encode_base64url(value)
      Base64.urlsafe_encode64(value, padding: false)
    end

  def decode_base64url(value, bytes:)
    decoded = Base64.urlsafe_decode64(value.to_s)
    valid_size = bytes.is_a?(Range) ? bytes.cover?(decoded.bytesize) : decoded.bytesize == bytes
    raise ArgumentError unless valid_size && encode_base64url(decoded) == value
      decoded
    rescue ArgumentError
      raise ArgumentError, "invalid base64url value"
    end

    def timestamp(value)
      value&.utc&.iso8601(3)
    end
  end
end
