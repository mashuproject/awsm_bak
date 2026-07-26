require "rails_helper"
require "digest"

RSpec.describe "Plan 15 Account Vault enrollment discovery", type: :request do
  let(:account) do
    Account.create!(
      email: "reader@example.test",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple"
    )
  end
  let(:issued) { Coordination::SessionCredentials.issue(account:, scope: "Account") }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000031",
      "Authorization" => "Bearer #{issued.fetch(:access_token)}"
    }
  end

  it "returns only Empty when the Account has no active synchronized Vault" do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000032",
      state: "Provisional",
      head_cursor: 0
    )

    get "/api/account/vault-enrollment", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("state" => "Empty")
  end

  it "returns only the active encrypted Recovery Kit for an attached Vault" do
    vault = account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000033",
      state: "Provisional",
      head_cursor: 1
    )
    ciphertext = "encrypted recovery keyring"
    recovery = vault.recovery_generations.create!(
      id: "01900000-0000-7000-8000-000000000034",
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
    vault.update!(state: "Active", active_recovery_generation: recovery)

    get "/api/account/vault-enrollment", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "state" => "Attached",
      "vaultId" => vault.vault_id,
      "recoveryKit" => {
        "version" => 1,
        "vaultId" => vault.vault_id,
        "recoveryGenerationId" => recovery.id,
        "derivationAlgorithm" => RecoveryGeneration::DERIVATION_ALGORITHM,
        "wrappingAlgorithm" => RecoveryGeneration::WRAPPING_ALGORITHM,
        "administratorSigningAlgorithm" => RecoveryGeneration::SIGNING_ALGORITHM,
        "administratorPublicKey" => Base64.urlsafe_encode64("a" * 32, padding: false),
        "nonce" => Base64.urlsafe_encode64("n" * 24, padding: false),
        "ciphertextLength" => ciphertext.bytesize,
        "ciphertextSha256" =>
          Base64.urlsafe_encode64(Digest::SHA256.digest(ciphertext), padding: false),
        "ciphertext" => Base64.urlsafe_encode64(ciphertext, padding: false)
      }
    )
    expect(response.body).not_to include("headCursor", "generationId", "displayName")
  end

  it "rejects VaultDevice scope" do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current, scope: "VaultDevice")
    )

    get "/api/account/vault-enrollment", headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHORIZATION_FAILED")
  end
end
