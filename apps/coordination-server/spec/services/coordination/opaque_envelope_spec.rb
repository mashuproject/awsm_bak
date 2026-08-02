require "rails_helper"

RSpec.describe Coordination::OpaqueEnvelope do
  class BoundedReadIo
    def initialize(bytes, maximum_read:)
      @io = StringIO.new(bytes)
      @maximum_read = maximum_read
    end

    def read(length)
      raise "unbounded read" if length > @maximum_read

      @io.read(length)
    end
  end

  def compact_envelope(payload: "\a".b * 16, protection_parameters: (0...64).to_a.pack("C*"))
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 1,
      2 => protection_parameters,
      3 => payload.bytesize,
      4 => Digest::SHA256.digest(payload),
      5 => 0
    )
    "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + payload
  end

  def stream_frame(index:, final:, ciphertext:)
    [ index ].pack("N") + (final ? "\x01" : "\x00").b +
      [ ciphertext.bytesize ].pack("N") + ciphertext
  end

  def streamable_envelope(payload:)
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 2,
      2 => "\x03".b * 64,
      3 => payload.bytesize,
      4 => Digest::SHA256.digest(payload),
      5 => 1_048_576
    )
    "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + payload
  end

  it "matches the canonical Client Compact vector without learning protected semantics" do
    parsed = described_class.parse(compact_envelope)

    expect(parsed).to have_attributes(
      storage_class: "Compact",
      byte_length: compact_envelope.bytesize,
      ciphertext_digest: Digest::SHA256.digest("\a".b * 16),
      storage_item_id: [
        "871846c4ad5f8d1dc06960790a533580e242b6a91c298769dd722864c6a6f73b"
      ].pack("H*")
    )
  end

  it "rejects malformed framing, noncanonical headers, payload changes, and unknown fields" do
    valid = compact_envelope
    malformed_magic = valid.dup.tap { |bytes| bytes.setbyte(0, bytes.getbyte(0) ^ 1) }
    changed_payload = valid.dup.tap { |bytes| bytes.setbyte(-1, bytes.getbyte(-1) ^ 1) }
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 1,
      2 => "\x00".b * 64,
      3 => 16,
      4 => Digest::SHA256.digest("\x00".b * 16),
      5 => 0,
      6 => 0
    )
    unknown_field = "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + "\x00".b * 16

    [ malformed_magic, valid.byteslice(0...-1), changed_payload, unknown_field ].each do |bytes|
      expect { described_class.parse(bytes) }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("outer_envelope_invalid")
      }
    end
  end

  it "accepts only one contiguous final Streamable frame sequence" do
    nonfinal = stream_frame(index: 0, final: false, ciphertext: "\x00".b * 1_048_592)
    final = stream_frame(index: 1, final: true, ciphertext: "\x00".b * 16)

    parsed = described_class.parse(streamable_envelope(payload: nonfinal + final))
    expect(parsed.storage_class).to eq("Streamable")

    missing_final = streamable_envelope(payload: nonfinal)
    wrong_index = streamable_envelope(
      payload: stream_frame(index: 1, final: true, ciphertext: "\x00".b * 16)
    )
    [ missing_final, wrong_index ].each do |bytes|
      expect { described_class.parse(bytes) }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("outer_envelope_invalid")
      }
    end
  end

  it "validates a Streamable envelope incrementally under the advertised ceiling" do
    nonfinal = stream_frame(index: 0, final: false, ciphertext: "\x05".b * 1_048_592)
    final = stream_frame(index: 1, final: true, ciphertext: "\x06".b * 16)
    envelope = streamable_envelope(payload: nonfinal + final)

    parsed = described_class.parse_io(
      BoundedReadIo.new(envelope, maximum_read: 64 * 1024),
      byte_length: envelope.bytesize,
      streamable_ceiling: nonfinal.bytesize + final.bytesize
    )

    expect(parsed).to have_attributes(
      storage_class: "Streamable",
      byte_length: envelope.bytesize,
      ciphertext_digest: Digest::SHA256.digest(nonfinal + final)
    )
    expect {
      described_class.parse_io(
        StringIO.new(envelope),
        byte_length: envelope.bytesize,
        streamable_ceiling: nonfinal.bytesize + final.bytesize - 1
      )
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("outer_envelope_invalid")
    }
  end
end
