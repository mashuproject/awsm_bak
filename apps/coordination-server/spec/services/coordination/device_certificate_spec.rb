require "rails_helper"
require "cbor"
require "openssl"

RSpec.describe Coordination::DeviceCertificate do
  let(:administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:device_signing) { OpenSSL::PKey.generate_key("ED25519") }
  let(:content) do
    {
      "version" => 1,
      "certificateId" => "01900000-0000-7000-8000-000000000015",
      "vaultId" => "01900000-0000-7000-8000-000000000011",
      "recoveryGenerationId" => "01900000-0000-7000-8000-000000000012",
      "deviceId" => "01900000-0000-7000-8000-000000000014",
      "displayName" => "Firefox extension",
      "clientKind" => "FirefoxExtension",
      "signingAlgorithm" => "sign:ed25519:device:v1",
      "signingPublicKey" => device_signing.raw_public_key,
      "wrappingAlgorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "wrappingPublicKey" => "w" * 32,
      "issuedAt" => "2026-07-25T17:00:00.000Z"
    }
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

  def encoded(value)
    CBOR.encode(canonical(value))
  end

  def wire(content_bytes: encoded(content), signature: administrator.sign(nil, content_bytes))
    {
      "content" => Base64.urlsafe_encode64(content_bytes, padding: false),
      "recoveryAdministratorPublicKey" =>
        Base64.urlsafe_encode64(administrator.raw_public_key, padding: false),
      "signature" => Base64.urlsafe_encode64(signature, padding: false)
    }
  end

  it "accepts one exact canonical current-recovery Device certificate" do
    certificate = described_class.decode!(
      wire,
      expected_vault_id: content.fetch("vaultId"),
      expected_recovery_generation_id: content.fetch("recoveryGenerationId"),
      expected_administrator_public_key: administrator.raw_public_key,
      now: Time.zone.parse("2026-07-25T17:01:00Z")
    )

    expect(certificate).to include(
      device_id: content.fetch("deviceId"),
      certificate_id: content.fetch("certificateId"),
      display_name: "Firefox extension",
      client_kind: "FirefoxExtension",
      signing_public_key: device_signing.raw_public_key,
      wrapping_public_key: "w" * 32
    )
  end

  it "rejects noncanonical, unknown-field, wrong-authority, future, and tampered certificates" do
    noncanonical = CBOR.encode(content)
    expect(noncanonical).not_to eq(encoded(content))

    invalid_values = [
      wire(content_bytes: noncanonical),
      wire(content_bytes: encoded(content.merge("unknown" => true))),
      wire(signature: "s" * 64),
      wire(content_bytes: encoded(content.merge("issuedAt" => "2026-07-25T17:07:00.000Z")))
    ]

    invalid_values.each do |value|
      expect {
        described_class.decode!(
          value,
          expected_vault_id: content.fetch("vaultId"),
          expected_recovery_generation_id: content.fetch("recoveryGenerationId"),
          expected_administrator_public_key: administrator.raw_public_key,
          now: Time.zone.parse("2026-07-25T17:01:00Z")
        )
      }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("DEVICE_ENROLLMENT_INVALID")
      }
    end
  end
end
