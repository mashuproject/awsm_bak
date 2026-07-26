require "rails_helper"
require "digest"
require "openssl"

RSpec.describe Coordination::DeviceKeyEnvelope do
  let(:administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:vault_id) { "01900000-0000-7000-8000-000000000011" }
  let(:recovery_generation_id) { "01900000-0000-7000-8000-000000000012" }
  let(:key_epoch_id) { "01900000-0000-7000-8000-000000000013" }
  let(:device_id) { "01900000-0000-7000-8000-000000000014" }
  let(:ciphertext) { "c" * 48 }
  let(:ciphertext_sha256) { Digest::SHA256.digest(ciphertext) }
  let(:metadata) do
    {
      "version" => 1,
      "vaultId" => vault_id,
      "recoveryGenerationId" => recovery_generation_id,
      "keyEpochId" => key_epoch_id,
      "deviceId" => device_id,
      "algorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "ephemeralPublicKey" => "e" * 32,
      "nonce" => "n" * 24,
      "ciphertextLength" => 48
    }
  end
  let(:metadata_cbor) { Coordination::CanonicalCbor.encode(metadata) }
  let(:signature_payload) do
    Coordination::CanonicalCbor.encode(
      "metadata" => metadata,
      "ciphertextSha256" => ciphertext_sha256
    )
  end
  let(:value) do
    {
      "metadata" => encode(metadata_cbor),
      "ciphertext" => encode(ciphertext),
      "ciphertextSha256" => encode(ciphertext_sha256),
      "administratorSignature" => encode(administrator.sign(nil, signature_payload))
    }
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  it "accepts one exact signed envelope for the certified Device and epoch" do
    envelope = described_class.decode!(
      value,
      expected_vault_id: vault_id,
      expected_recovery_generation_id: recovery_generation_id,
      expected_key_epoch_id: key_epoch_id,
      expected_device_id: device_id,
      expected_administrator_public_key: administrator.raw_public_key
    )

    expect(envelope).to include(
      vault_device_id: device_id,
      vault_key_epoch_id: key_epoch_id,
      recovery_generation_id:,
      ephemeral_public_key: "e" * 32,
      nonce: "n" * 24,
      ciphertext:,
      ciphertext_sha256:,
      signed_metadata: signature_payload
    )
  end

  it "rejects unknown metadata, binding changes, checksum changes, and invalid signatures" do
    unknown_metadata = Coordination::CanonicalCbor.encode(metadata.merge("unknown" => true))
    invalid_values = [
      value.merge("unknown" => true),
      value.merge("metadata" => encode(unknown_metadata)),
      value.merge("ciphertext" => encode("d" * 48)),
      value.merge("administratorSignature" => encode("s" * 64))
    ]

    invalid_values.each do |candidate|
      expect {
        described_class.decode!(
          candidate,
          expected_vault_id: vault_id,
          expected_recovery_generation_id: recovery_generation_id,
          expected_key_epoch_id: key_epoch_id,
          expected_device_id: device_id,
          expected_administrator_public_key: administrator.raw_public_key
        )
      }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("DEVICE_ENROLLMENT_INVALID")
      }
    end
  end
end
