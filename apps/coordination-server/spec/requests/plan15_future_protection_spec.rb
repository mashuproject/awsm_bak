require "rails_helper"
require "digest"
require "openssl"

RSpec.describe "Plan 15 future-content protection", type: :request do
  let(:account) do
    Account.create!(
      email: "owner@example.test",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple"
    )
  end
  let(:vault) do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000201",
      state: "Active",
      head_cursor: 1
    )
  end
  let(:old_administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:old_recovery) { create_recovery("01900000-0000-7000-8000-000000000202", 0, old_administrator) }
  let(:old_epoch) do
    vault.vault_key_epochs.create!(
      id: "01900000-0000-7000-8000-000000000203",
      recovery_generation: old_recovery,
      ordinal: 0,
      activated_at: Time.current
    )
  end
  let!(:initiator) do
    create_device(
      id: "01900000-0000-7000-8000-000000000204",
      certificate_id: "01900000-0000-7000-8000-000000000205",
      display_name: "Current Firefox",
      signing_public_key: OpenSSL::PKey.generate_key("ED25519").raw_public_key,
      wrapping_public_key: "i" * 32
    )
  end
  let!(:target) do
    create_device(
      id: "01900000-0000-7000-8000-000000000206",
      certificate_id: "01900000-0000-7000-8000-000000000207",
      display_name: "Lost Chrome",
      signing_public_key: OpenSSL::PKey.generate_key("ED25519").raw_public_key,
      wrapping_public_key: "t" * 32
    )
  end
  let(:issued) do
    Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: initiator.device_id
    )
  end
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000208",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000209",
      "Authorization" => "Bearer #{issued.fetch(:access_token)}",
      "Content-Type" => "application/json"
    }
  end
  let(:new_administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:new_recovery_id) { "01900000-0000-7000-8000-000000000210" }
  let(:new_epoch_id) { "01900000-0000-7000-8000-000000000211" }

  before do
    generation = vault.vault_generations.create!(
      generation_id: "01900000-0000-7000-8000-000000000213",
      generation_number: 0,
      state: "Active"
    )
    vault.update!(
      active_recovery_generation: old_recovery,
      active_key_epoch: old_epoch,
      active_generation: generation,
      active_generation_number: 0
    )
    [ initiator, target ].each do |device|
      device.device_key_envelopes.create!(
        vault_key_epoch: old_epoch,
        recovery_generation: old_recovery,
        algorithm: DeviceKeyEnvelope::ALGORITHM,
        ephemeral_public_key: "e" * 32,
        nonce: "n" * 24,
        ciphertext: "c" * 48,
        ciphertext_sha256: Digest::SHA256.digest("c" * 48),
        signed_metadata: "old",
        administrator_signature: "s" * 64
      )
    end
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  def create_recovery(id, ordinal, administrator)
    ciphertext = "encrypted recovery keyring #{ordinal}"
    vault.recovery_generations.create!(
      id:,
      ordinal:,
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

  def create_device(id:, certificate_id:, display_name:, signing_public_key:, wrapping_public_key:)
    vault.vault_devices.create!(
      device_id: id,
      recovery_generation: old_recovery,
      certificate_id:,
      display_name:,
      client_kind: "FirefoxExtension",
      signing_algorithm: "sign:ed25519:device:v1",
      signing_public_key:,
      wrapping_algorithm: DeviceKeyEnvelope::ALGORITHM,
      wrapping_public_key:,
      certificate_cbor: "old certificate",
      certificate_signature: "s" * 64,
      enrolled_at: Time.current
    )
  end

  def recovery_wire
    ciphertext = "new encrypted recovery keyring"
    {
      version: 1,
      vaultId: vault.vault_id,
      recoveryGenerationId: new_recovery_id,
      derivationAlgorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
      wrappingAlgorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
      administratorSigningAlgorithm: RecoveryGeneration::SIGNING_ALGORITHM,
      administratorPublicKey: encode(new_administrator.raw_public_key),
      nonce: encode("r" * 24),
      ciphertextLength: ciphertext.bytesize,
      ciphertextSha256: encode(Digest::SHA256.digest(ciphertext)),
      ciphertext: encode(ciphertext)
    }
  end

  def certificate_wire(device)
    content = {
      "version" => 1,
      "certificateId" => "01900000-0000-7000-8000-000000000212",
      "vaultId" => vault.vault_id,
      "recoveryGenerationId" => new_recovery_id,
      "deviceId" => device.device_id,
      "displayName" => device.display_name,
      "clientKind" => device.client_kind,
      "signingAlgorithm" => device.signing_algorithm,
      "signingPublicKey" => device.signing_public_key,
      "wrappingAlgorithm" => device.wrapping_algorithm,
      "wrappingPublicKey" => device.wrapping_public_key,
      "issuedAt" => Time.current.utc.iso8601(3)
    }
    cbor = Coordination::CanonicalCbor.encode(content)
    {
      content: encode(cbor),
      recoveryAdministratorPublicKey: encode(new_administrator.raw_public_key),
      signature: encode(new_administrator.sign(nil, cbor))
    }
  end

  def envelope_wire(device)
    metadata = {
      "version" => 1,
      "vaultId" => vault.vault_id,
      "recoveryGenerationId" => new_recovery_id,
      "keyEpochId" => new_epoch_id,
      "deviceId" => device.device_id,
      "algorithm" => DeviceKeyEnvelope::ALGORITHM,
      "ephemeralPublicKey" => "e" * 32,
      "nonce" => "n" * 24,
      "ciphertextLength" => 48
    }
    ciphertext = "c" * 48
    digest = Digest::SHA256.digest(ciphertext)
    signed = Coordination::CanonicalCbor.encode(
      "metadata" => metadata,
      "ciphertextSha256" => digest
    )
    {
      metadata: encode(Coordination::CanonicalCbor.encode(metadata)),
      ciphertext: encode(ciphertext),
      ciphertextSha256: encode(digest),
      administratorSignature: encode(new_administrator.sign(nil, signed))
    }
  end

  def request_body
    {
      expectedRecoveryGenerationId: old_recovery.id,
      expectedKeyEpochId: old_epoch.id,
      targetDeviceId: target.device_id,
      recoveryGeneration: recovery_wire,
      keyEpoch: { keyEpochId: new_epoch_id, ordinal: 1 },
      remainingDevices: [
        {
          deviceCertificate: certificate_wire(initiator),
          deviceKeyEnvelope: envelope_wire(initiator)
        }
      ]
    }
  end

  it "atomically rotates recovery and epoch authority while excluding the target Device" do
    target_session = Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: target.device_id
    ).fetch(:session)

    post "/api/vaults/#{vault.vault_id}/future-protections",
      params: request_body.to_json,
      headers: headers

    expect(response).to have_http_status(:ok), response.body
    expect(vault.reload).to have_attributes(
      active_recovery_generation_id: new_recovery_id,
      active_key_epoch_id: new_epoch_id
    )
    expect(old_recovery.reload).to have_attributes(retired_at: be_present, kit_ciphertext: nil)
    expect(target.reload).to have_attributes(
      revocation_reason: "FutureProtection",
      revoked_at: be_present
    )
    expect(initiator.reload.recovery_generation_id).to eq(new_recovery_id)
    expect(initiator.device_key_envelopes.pluck(:vault_key_epoch_id)).to contain_exactly(new_epoch_id)
    expect(issued.fetch(:session).reload).to be_revoked
    expect(target_session.reload).to be_revoked

    renewed = Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: initiator.device_id
    )
    get "/api/vaults/#{vault.vault_id}/device-authority",
      headers: headers.merge(
        "Authorization" => "Bearer #{renewed.fetch(:access_token)}",
        "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000214"
      ).except("Idempotency-Key", "Content-Type")
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include(
      "activeRecoveryGenerationId" => new_recovery_id,
      "activeKeyEpochId" => new_epoch_id,
      "keyEpochOrdinal" => 1
    )
    expect(response.parsed_body.fetch("deviceCertificate")).to include("content", "signature")
    expect(response.parsed_body.fetch("deviceKeyEnvelope")).to include("metadata", "ciphertext")
  end

  it "rejects a stale compare-and-swap without mutating authority" do
    body = request_body.merge(
      expectedRecoveryGenerationId: "01900000-0000-7000-8000-000000000299"
    )

    post "/api/vaults/#{vault.vault_id}/future-protections",
      params: body.to_json,
      headers: headers

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("RECOVERY_GENERATION_CHANGED")
    expect(vault.reload).to have_attributes(
      active_recovery_generation_id: old_recovery.id,
      active_key_epoch_id: old_epoch.id
    )
    expect(target.reload).to be_active
  end

  it "rejects changed Device public facts" do
    body = request_body
    body.fetch(:remainingDevices).first[:deviceCertificate] = certificate_wire(target)

    post "/api/vaults/#{vault.vault_id}/future-protections",
      params: body.to_json,
      headers: headers

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("DEVICE_ENROLLMENT_INVALID")
    expect(target.reload).to be_active
  end
end
