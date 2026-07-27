require "rails_helper"

RSpec.describe "Plan 20 Account dashboard", type: :request do
  let(:password) { "correct horse battery staple" }
  let(:account) do
    create_account(
      username: "quiet_vault",
      password:,
      password_confirmation: password,
      last_activity_at: Time.utc(2026, 7, 20, 12)
    )
  end

  def sign_in
    post "/session",
      params: { username: account.username, password: },
      headers: { "User-Agent" => "Mozilla/5.0 Firefox/140.0" }
    expect(response).to redirect_to("/account")
    account.browser_sessions.order(:created_at).last
  end

  def create_device(vault:, recovery:, name:, kind:, removed_at: nil)
    vault.vault_devices.create!(
      device_id: SecureRandom.uuid,
      recovery_generation: recovery,
      certificate_id: SecureRandom.uuid,
      display_name: name,
      client_kind: kind,
      signing_algorithm: "sign:ed25519:device:v1",
      signing_public_key: SecureRandom.random_bytes(32),
      wrapping_algorithm: DeviceKeyEnvelope::ALGORITHM,
      wrapping_public_key: SecureRandom.random_bytes(32),
      certificate_cbor: "certificate-#{name}",
      certificate_signature: SecureRandom.random_bytes(64),
      enrolled_at: Time.utc(2026, 7, 1, 12),
      revoked_at: removed_at,
      revocation_reason: removed_at ? "Removed" : nil
    )
  end

  it "renders one private dashboard with username, Vault state, counts, and exact deadline" do
    sign_in
    deadline = I18n.l(
      (account.reload.last_activity_at + 365.days).to_date,
      format: :long
    )

    get "/account"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to eq("private, no-store")
    expect(response.body).to include(
      "Overview",
      "Devices",
      "Website sessions",
      "Security",
      "Delete Account",
      "quiet_vault",
      "No synchronized Vault",
      deadline
    )
    expect(response.body).not_to include("API sessions", "@example.test")
    expect(Nokogiri::HTML(response.body).css('input[type="email"]')).to be_empty
  end

  it "renders only allowlisted active and removed Device facts without website mutation" do
    vault = account.vault_replicas.create!(
      vault_id: SecureRandom.uuid,
      state: "Active",
      head_cursor: 0
    )
    ciphertext = "encrypted recovery keyring"
    recovery = vault.recovery_generations.create!(
      id: SecureRandom.uuid,
      ordinal: 0,
      derivation_algorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
      wrapping_algorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
      administrator_signing_algorithm: RecoveryGeneration::SIGNING_ALGORITHM,
      administrator_public_key: SecureRandom.random_bytes(32),
      kit_nonce: SecureRandom.random_bytes(24),
      kit_ciphertext: ciphertext,
      kit_ciphertext_length: ciphertext.bytesize,
      kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext),
      activated_at: Time.current
    )
    active = create_device(
      vault:,
      recovery:,
      name: "Current Firefox",
      kind: "FirefoxExtension"
    )
    removed = create_device(
      vault:,
      recovery:,
      name: "Old Chrome",
      kind: "ChromeExtension",
      removed_at: Time.utc(2026, 7, 10, 12)
    )
    sign_in

    get "/account"

    expect(response.body).to include(
      "Synchronized Vault attached",
      "Current Firefox",
      "Firefox",
      "Active",
      "Old Chrome",
      "Chrome",
      "Removed",
      "Manage Devices in the AWSM extension"
    )
    expect(response.body).not_to include(
      vault.vault_id,
      active.device_id,
      removed.device_id,
      active.certificate_id,
      "certificate-Current Firefox",
      recovery.id,
      "Remove Device"
    )
    expect(response.body).not_to match(%r{/account/devices|/api/vaults/.+/devices})
  end

  it "revokes another website session while preserving the current session" do
    current = sign_in
    other = account.browser_sessions.create!(
      client_family: "Chrome",
      last_activity_at: 2.days.ago
    )

    delete "/account/browser-sessions/#{other.id}"

    expect(response).to redirect_to("/account#website-sessions")
    expect(account.browser_sessions.reload).to contain_exactly(current)
    follow_redirect!
    expect(response).to have_http_status(:ok)
  end

  it "refuses current and cross-Account session identifiers without leaking ownership" do
    current = sign_in
    foreign = create_account.browser_sessions.create!(
      client_family: "Other",
      last_activity_at: Time.current
    )

    delete "/account/browser-sessions/#{current.id}"
    expect(response).to have_http_status(:unprocessable_content)
    expect(account.browser_sessions.exists?(current.id)).to be(true)

    delete "/account/browser-sessions/#{foreign.id}"
    expect(response).to have_http_status(:not_found)
    expect(BrowserSession.exists?(foreign.id)).to be(true)
  end

  it "signs out all other website sessions and never lists API sessions" do
    current = sign_in
    2.times do
      account.browser_sessions.create!(
        client_family: "Other",
        last_activity_at: 2.days.ago
      )
    end
    account.api_sessions.create!(scope: "Account", confirmed_at: Time.current)

    delete "/account/browser-sessions"

    expect(response).to redirect_to("/account#website-sessions")
    expect(account.browser_sessions.reload).to contain_exactly(current)

    follow_redirect!
    expect(response.body).not_to include("API sessions")
  end
end
