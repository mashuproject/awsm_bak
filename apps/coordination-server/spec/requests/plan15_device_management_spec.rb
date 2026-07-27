require "rails_helper"
require "digest"
require "openssl"

RSpec.describe "Plan 15 Device management", type: :request do
  let(:account) do
    Account.create!(
      username: "reader",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )
  end
  let(:vault) do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000081",
      state: "Active",
      head_cursor: 1
    )
  end
  let(:recovery) do
    ciphertext = "encrypted recovery keyring"
    vault.recovery_generations.create!(
      id: "01900000-0000-7000-8000-000000000082",
      ordinal: 0,
      derivation_algorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
      wrapping_algorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
      administrator_signing_algorithm: RecoveryGeneration::SIGNING_ALGORITHM,
      administrator_public_key: "a" * 32,
      kit_nonce: "n" * 24,
      kit_ciphertext: ciphertext,
      kit_ciphertext_length: ciphertext.bytesize,
      kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext),
      activated_at: Time.current
    )
  end

  def create_device(id:, certificate_id:, display_name:)
    vault.vault_devices.create!(
      device_id: id,
      recovery_generation: recovery,
      certificate_id:,
      display_name:,
      client_kind: "FirefoxExtension",
      signing_algorithm: "sign:ed25519:device:v1",
      signing_public_key: OpenSSL::PKey.generate_key("ED25519").raw_public_key,
      wrapping_algorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      wrapping_public_key: "w" * 32,
      certificate_cbor: "certificate",
      certificate_signature: "s" * 64,
      enrolled_at: Time.current
    )
  end

  let!(:current_device) do
    create_device(
      id: "01900000-0000-7000-8000-000000000083",
      certificate_id: "01900000-0000-7000-8000-000000000084",
      display_name: "Current Firefox"
    )
  end
  let!(:other_device) do
    create_device(
      id: "01900000-0000-7000-8000-000000000085",
      certificate_id: "01900000-0000-7000-8000-000000000086",
      display_name: "Other Firefox"
    )
  end
  let(:issued) do
    Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: current_device.device_id
    )
  end
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000087",
      "Authorization" => "Bearer #{issued.fetch(:access_token)}"
    }
  end

  it "lists only public certificate facts and identifies the current Device" do
    get "/api/vaults/#{vault.vault_id}/devices", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("devices")).to contain_exactly(
      include(
        "deviceId" => current_device.device_id,
        "displayName" => "Current Firefox",
        "recoveryGenerationId" => recovery.id,
        "deviceCertificate" => include("content", "recoveryAdministratorPublicKey", "signature"),
        "current" => true
      ),
      include(
        "deviceId" => other_device.device_id,
        "displayName" => "Other Firefox",
        "current" => false
      )
    )
    expect(response.body).not_to include("ciphertext")
  end

  it "does not authorize the current Device against another Vault owned by the same Account" do
    other_vault = account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000089",
      state: "Provisional",
      head_cursor: 0
    )

    get "/api/vaults/#{other_vault.vault_id}/devices", headers: headers

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body.fetch("outcome")).to eq("VAULT_NOT_FOUND")
  end

  it "removes active Device authority, revokes its sessions, and rejects a repeated removal" do
    removed_session = Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: other_device.device_id
    ).fetch(:session)

    delete "/api/vaults/#{vault.vault_id}/devices/#{other_device.device_id}", headers: headers
    expect(response).to have_http_status(:no_content)

    delete "/api/vaults/#{vault.vault_id}/devices/#{other_device.device_id}", headers: headers
    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("DEVICE_ENROLLMENT_INVALID")

    expect(other_device.reload).to have_attributes(
      revocation_reason: "Removed",
      revoked_at: be_present
    )
    expect(removed_session.reload).to be_revoked
    expect(current_device.reload).to be_active
  end
end
