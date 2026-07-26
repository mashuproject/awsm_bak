require "rails_helper"
require "digest"

RSpec.describe Coordination::RecoveryKit do
  let(:vault_id) { "01900000-0000-7000-8000-000000000011" }
  let(:recovery_generation_id) { "01900000-0000-7000-8000-000000000012" }
  let(:ciphertext) { "encrypted recovery keyring" }
  let(:value) do
    {
      "version" => 1,
      "vaultId" => vault_id,
      "recoveryGenerationId" => recovery_generation_id,
      "derivationAlgorithm" => "kdf:hkdf-sha256:recovery-entropy:v1",
      "wrappingAlgorithm" => "wrap:xchacha20poly1305:recovery-kit:v1",
      "administratorSigningAlgorithm" => "sign:ed25519:recovery-administrator:v1",
      "administratorPublicKey" => encode("a" * 32),
      "nonce" => encode("n" * 24),
      "ciphertextLength" => ciphertext.bytesize,
      "ciphertextSha256" => encode(Digest::SHA256.digest(ciphertext)),
      "ciphertext" => encode(ciphertext)
    }
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  it "accepts one exact Recovery Kit bound to the submitted Vault and generation" do
    kit = described_class.decode!(
      value,
      expected_vault_id: vault_id,
      expected_recovery_generation_id: recovery_generation_id
    )

    expect(kit).to include(
      vault_id:,
      recovery_generation_id:,
      administrator_public_key: "a" * 32,
      kit_nonce: "n" * 24,
      kit_ciphertext: ciphertext,
      kit_ciphertext_length: ciphertext.bytesize,
      kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext)
    )
  end

  it "rejects unknown fields, identifier substitution, malformed bytes, and ciphertext mismatch" do
    invalid_values = [
      value.merge("unknown" => true),
      value.merge("vaultId" => "01900000-0000-7000-8000-000000000099"),
      value.merge("administratorPublicKey" => encode("short")),
      value.merge("ciphertextLength" => ciphertext.bytesize + 1),
      value.merge("ciphertextSha256" => encode("x" * 32)),
      value.merge("ciphertext" => "#{value.fetch("ciphertext")}=")
    ]

    invalid_values.each do |candidate|
      expect {
        described_class.decode!(
          candidate,
          expected_vault_id: vault_id,
          expected_recovery_generation_id: recovery_generation_id
        )
      }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("DEVICE_ENROLLMENT_INVALID")
      }
    end
  end
end
