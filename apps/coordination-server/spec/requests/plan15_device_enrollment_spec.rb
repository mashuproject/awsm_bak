require "rails_helper"
require "digest"
require "openssl"

RSpec.describe "Plan 15 recovered Device enrollment", type: :request do
  let(:account) do
    Account.create!(
      email: "reader@example.test",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple"
    )
  end
  let(:account_issued) { Coordination::SessionCredentials.issue(account:, scope: "Account") }
  let(:vault) do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000051",
      state: "Provisional",
      head_cursor: 1
    )
  end
  let(:administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:recovery) do
    ciphertext = "encrypted recovery keyring"
    vault.recovery_generations.create!(
      id: "01900000-0000-7000-8000-000000000052",
      ordinal: 0,
      derivation_algorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
      wrapping_algorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
      administrator_signing_algorithm: RecoveryGeneration::SIGNING_ALGORITHM,
      administrator_public_key: administrator.raw_public_key,
      kit_nonce: "n" * 24,
      kit_ciphertext: ciphertext,
      kit_ciphertext_length: ciphertext.bytesize,
      kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext),
      activated_at: Time.current
    )
  end
  let!(:epochs) do
    first = vault.vault_key_epochs.create!(
      id: "01900000-0000-7000-8000-000000000053",
      recovery_generation: recovery,
      ordinal: 0,
      activated_at: 1.day.ago,
      retired_at: 1.hour.ago
    )
    second = vault.vault_key_epochs.create!(
      id: "01900000-0000-7000-8000-000000000054",
      recovery_generation: recovery,
      ordinal: 1,
      activated_at: 1.hour.ago
    )
    vault.update!(
      state: "Active",
      active_recovery_generation: recovery,
      active_key_epoch: second
    )
    [ first, second ]
  end
  let(:device_signing) { OpenSSL::PKey.generate_key("ED25519") }
  let(:device_id) { "01900000-0000-7000-8000-000000000055" }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000057",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000058",
      "Authorization" => "Bearer #{account_issued.fetch(:access_token)}",
      "Content-Type" => "application/json"
    }
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  def enrollment_body
    content = {
      "version" => 1,
      "certificateId" => "01900000-0000-7000-8000-000000000056",
      "vaultId" => vault.vault_id,
      "recoveryGenerationId" => recovery.id,
      "deviceId" => device_id,
      "displayName" => "Chrome extension",
      "clientKind" => "ChromeExtension",
      "signingAlgorithm" => "sign:ed25519:device:v1",
      "signingPublicKey" => device_signing.raw_public_key,
      "wrappingAlgorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "wrappingPublicKey" => "w" * 32,
      "issuedAt" => Time.current.utc.iso8601(3)
    }
    content_cbor = Coordination::CanonicalCbor.encode(content)
    certificate_signature = administrator.sign(nil, content_cbor)
    certificate = {
      content: encode(content_cbor),
      recoveryAdministratorPublicKey: encode(administrator.raw_public_key),
      signature: encode(certificate_signature)
    }
    proof_transcript = Coordination::CanonicalCbor.encode(
      "domain" => "awsm:device-enrollment-proof:v1",
      "certificateSha256" => Digest::SHA256.digest(content_cbor),
      "certificateSignatureSha256" => Digest::SHA256.digest(certificate_signature),
      "accountSessionId" => account_issued.fetch(:session).id
    )
    envelopes = epochs.map do |epoch|
      metadata = {
        "version" => 1,
        "vaultId" => vault.vault_id,
        "recoveryGenerationId" => recovery.id,
        "keyEpochId" => epoch.id,
        "deviceId" => device_id,
        "algorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
        "ephemeralPublicKey" => "e" * 32,
        "nonce" => "n" * 24,
        "ciphertextLength" => 48
      }
      ciphertext = "c" * 48
      sha256 = Digest::SHA256.digest(ciphertext)
      signed = Coordination::CanonicalCbor.encode(
        "metadata" => metadata,
        "ciphertextSha256" => sha256
      )
      {
        metadata: encode(Coordination::CanonicalCbor.encode(metadata)),
        ciphertext: encode(ciphertext),
        ciphertextSha256: encode(sha256),
        administratorSignature: encode(administrator.sign(nil, signed))
      }
    end
    {
      deviceCertificate: certificate,
      deviceKeyEnvelopes: envelopes,
      deviceProofSignature: encode(device_signing.sign(nil, proof_transcript))
    }
  end

  it "atomically enrolls a certified Device with one envelope for every epoch" do
    post "/api/vaults/#{vault.vault_id}/devices",
      params: enrollment_body.to_json,
      headers: headers

    expect(response).to have_http_status(:created)
    expect(response.parsed_body.fetch("scope")).to eq("VaultDevice")
    device = vault.vault_devices.find(device_id)
    expect(device.device_key_envelopes.order(:vault_key_epoch_id).pluck(:vault_key_epoch_id))
      .to match_array(epochs.map(&:id))
    expect(ApiSession.find(response.parsed_body.fetch("sessionId")).vault_device).to eq(device)
  end

  it "rejects an incomplete epoch set without creating a Device" do
    incomplete = enrollment_body
    incomplete[:deviceKeyEnvelopes] = incomplete.fetch(:deviceKeyEnvelopes).take(1)

    post "/api/vaults/#{vault.vault_id}/devices",
      params: incomplete.to_json,
      headers: headers

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("DEVICE_ENROLLMENT_INVALID")
    expect(vault.vault_devices).to be_empty
    expect(DeviceKeyEnvelope.count).to eq(0)
  end
end
