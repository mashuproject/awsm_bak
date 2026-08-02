require "digest"
require "stringio"

module Coordination
  class OpaqueEnvelope
    MAGIC = "AWSMSE\x01\x00".b.freeze
    HEADER_LIMIT = 4_096
    COMPACT_CEILING = 16 * 1024 * 1024
    FRAME_PLAINTEXT_LIMIT = 1_048_576
    FRAME_TAG_LENGTH = 16
    MAXIMUM_STREAMABLE_BYTES = 9_007_199_254_740_991
    READ_CHUNK_LENGTH = 64 * 1024
    TRANSCRIPT_LABEL = "awsm:storage-item-id:v1".b.freeze

    Parsed = Data.define(
      :storage_item_id,
      :storage_class,
      :byte_length,
      :ciphertext_digest
    )

    class DigestingReader
      def initialize(io, digest)
        @io = io
        @digest = digest
      end

      def read_exact(length)
        value = +"".b
        while value.bytesize < length
          chunk = @io.read([ length - value.bytesize, READ_CHUNK_LENGTH ].min)
          OpaqueEnvelope.send(:invalid!) if chunk.nil? || chunk.empty?

          chunk = chunk.b
          value << chunk
          @digest.update(chunk)
        end
        value
      end

      def consume_exact(length)
        remaining = length
        while remaining.positive?
          chunk = read_exact([ remaining, READ_CHUNK_LENGTH ].min)
          yield chunk
          remaining -= chunk.bytesize
        end
      end

      def finished?
        extra = @io.read(1)
        extra.nil? || extra.empty?
      end
    end
    private_constant :DigestingReader

    class << self
      def parse(value, compact_ceiling: COMPACT_CEILING,
        streamable_ceiling: MAXIMUM_STREAMABLE_BYTES)
        invalid! unless value.is_a?(String)

        parse_io(
          StringIO.new(value.b),
          byte_length: value.bytesize,
          compact_ceiling:,
          streamable_ceiling:
        )
      end

      def parse_io(io, byte_length:, compact_ceiling: COMPACT_CEILING,
        streamable_ceiling: MAXIMUM_STREAMABLE_BYTES)
        invalid! unless io.respond_to?(:read)
        invalid! unless byte_length.is_a?(Integer) && byte_length.positive? &&
          byte_length <= MAXIMUM_STREAMABLE_BYTES
        invalid! unless (1..COMPACT_CEILING).cover?(compact_ceiling)
        invalid! unless (1..MAXIMUM_STREAMABLE_BYTES).cover?(streamable_ceiling)

        storage_digest = Digest::SHA256.new
        storage_digest.update(
          TRANSCRIPT_LABEL + "\x00".b + [ 1 ].pack("N") + [ byte_length ].pack("Q>")
        )
        reader = DigestingReader.new(io, storage_digest)
        invalid! unless reader.read_exact(MAGIC.bytesize) == MAGIC

        header_length = reader.read_exact(4).unpack1("N")
        invalid! unless (1..HEADER_LIMIT).cover?(header_length)
        header = CanonicalCbor.decode(reader.read_exact(header_length))
        invalid! unless header.is_a?(Hash) && header.keys.sort == (0..5).to_a

        storage_format = nonnegative_integer(header.fetch(0))
        storage_class_code = nonnegative_integer(header.fetch(1))
        protection_parameters = exact_bytes(header.fetch(2), 64)
        ciphertext_length = nonnegative_integer(header.fetch(3))
        ciphertext_digest = exact_bytes(header.fetch(4), 32)
        frame_plaintext_limit = nonnegative_integer(header.fetch(5))
        invalid! unless storage_format == 1 && protection_parameters.bytesize == 64
        invalid! unless byte_length == MAGIC.bytesize + 4 + header_length + ciphertext_length

        payload_digest = Digest::SHA256.new
        storage_class = validate_payload_io!(
          reader:,
          storage_class_code:,
          frame_plaintext_limit:,
          ciphertext_length:,
          payload_digest:,
          compact_ceiling:,
          streamable_ceiling:
        )
        invalid! unless payload_digest.digest == ciphertext_digest && reader.finished?

        Parsed.new(
          storage_item_id: storage_digest.digest,
          storage_class:,
          byte_length:,
          ciphertext_digest:
        )
      rescue ArgumentError, KeyError, TypeError
        invalid!
      end

      private

      def validate_payload_io!(reader:, storage_class_code:, frame_plaintext_limit:,
        ciphertext_length:, payload_digest:, compact_ceiling:, streamable_ceiling:)
        case storage_class_code
        when 1
          invalid! unless frame_plaintext_limit.zero?
          invalid! unless (FRAME_TAG_LENGTH..compact_ceiling).cover?(ciphertext_length)
          reader.consume_exact(ciphertext_length) { |chunk| payload_digest.update(chunk) }
          "Compact"
        when 2
          invalid! unless frame_plaintext_limit == FRAME_PLAINTEXT_LIMIT
          invalid! unless (FRAME_TAG_LENGTH + 9..streamable_ceiling).cover?(ciphertext_length)
          validate_streamable_io!(reader, ciphertext_length, payload_digest)
          "Streamable"
        else
          invalid!
        end
      end

      def validate_streamable_io!(reader, payload_length, payload_digest)
        offset = 0
        expected_index = 0
        saw_final = false
        while offset < payload_length
          invalid! if saw_final || payload_length - offset < 9
          prefix = reader.read_exact(9)
          payload_digest.update(prefix)
          index, flags, ciphertext_length = prefix.unpack("NCN")
          invalid! unless index == expected_index && (flags & 0xfe).zero?

          final = (flags & 1) == 1
          minimum = final ? FRAME_TAG_LENGTH : FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH
          maximum = FRAME_PLAINTEXT_LIMIT + FRAME_TAG_LENGTH
          invalid! unless (minimum..maximum).cover?(ciphertext_length)
          offset += 9
          invalid! if payload_length - offset < ciphertext_length

          reader.consume_exact(ciphertext_length) { |chunk| payload_digest.update(chunk) }
          offset += ciphertext_length
          expected_index += 1
          saw_final = final
        end
        invalid! unless saw_final && expected_index.positive?
      end

      def nonnegative_integer(value)
        invalid! unless value.is_a?(Integer) && value >= 0

        value
      end

      def exact_bytes(value, length)
        invalid! unless value.is_a?(String) && value.encoding == Encoding::BINARY && value.bytesize == length

        value
      end

      def invalid!
        raise OutcomeError.new("outer_envelope_invalid", status: :unprocessable_content)
      end
    end
  end
end
