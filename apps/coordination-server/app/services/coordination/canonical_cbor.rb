require "cbor"

module Coordination
  module CanonicalCbor
    module_function

    def decode(value)
      decoded = CBOR.decode(value)
      raise ArgumentError, "non-canonical CBOR" unless encode(decoded) == value

      decoded
    rescue CBOR::MalformedFormatError, EOFError, TypeError
      raise ArgumentError, "invalid CBOR"
    end

    def encode(value)
      CBOR.encode(canonical(value))
    end

    def canonical(value)
      case value
      when Hash
        value.to_a.sort_by { |key, _| encoded = CBOR.encode(key); [ encoded.bytesize, encoded ] }
          .to_h { |key, child| [ key, canonical(child) ] }
      when Array
        value.map { |child| canonical(child) }
      else
        value
      end
    end
    private_class_method :canonical
  end
end
