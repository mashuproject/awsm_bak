require "rails_helper"

RSpec.describe "Plan 15 Account authentication", type: :request do
  let(:protocol_headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000002",
      "Content-Type" => "application/json"
    }
  end

  def json_request(method, path, body:)
    public_send(method, path, params: body.to_json, headers: protocol_headers)
  end

  it "uses one private username and conventional Rails password credential" do
    account = Account.create!(
      username: " Quiet_Vault ",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )

    expect(account.username).to eq("quiet_vault")
    expect(account.password_digest).to be_present
    expect(account.authenticate("correct horse battery staple")).to eq(account)
    expect(account.authenticate("incorrect")).to be(false)
    expect(account.attributes).not_to include(
      "authentication_secret_digest",
      "account_key_id",
      "kdf_salt",
      "kdf_operations",
      "kdf_memory_bytes",
      "key_envelope_algorithm",
      "key_envelope_nonce",
      "key_envelope_ciphertext"
    )
  end

  it "logs the extension in with the raw Account password and returns Account scope only" do
    account = Account.create!(
      username: "quiet_vault",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )

    json_request(:post, "/api/sessions",
      body: { username: "quiet_vault", password: "correct horse battery staple" })

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include(
      "account" => {
        "accountId" => account.id,
        "username" => "quiet_vault",
        "inactiveDeletionAt" => (account.last_activity_at + 365.days).iso8601(3)
      },
      "scope" => "Account"
    )
    expect(response.parsed_body).not_to include("accountKeyEnvelope")
    expect(response.body).not_to include("authenticationSecret", "accountKeyId", "kdf")
    expect(ApiSession.find(response.parsed_body.fetch("sessionId"))).to have_attributes(
      account:,
      scope: "Account",
      vault_device_id: nil
    )
  end

  it "does not route extension-owned Account creation or authentication parameters" do
    expect {
      Rails.application.routes.recognize_path("/api/accounts", method: :post)
    }.to raise_error(ActionController::RoutingError)
    expect {
      Rails.application.routes.recognize_path("/api/authentication-parameters", method: :post)
    }.to raise_error(ActionController::RoutingError)
  end

  it "advertises server-owned registration without key-envelope capabilities" do
    get "/api/server-information", headers: protocol_headers.except("Content-Type")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "service" => "AWSM Coordination Server",
      "protocolVersion" => "1",
      "capabilities" => {
        "accountPassword" => true,
        "accountVaultLimit" => 1,
        "completeReplicaSynchronization" => true,
        "deviceEnrollment" => "RecoveryPhrase",
        "deviceRevocation" => true
      },
      "registration" => {
        "enabled" => true,
        "signUpUrl" => "http://www.example.com/sign_up"
      },
      "accountPolicy" => {
        "inactiveRetentionDays" => 365
      }
    )
  end

  it "creates an Account through the Rails signup form and establishes a browser session" do
    post "/sign_up", params: {
      account: {
        username: " Quiet_Vault ",
        password: "correct horse battery staple",
        password_confirmation: "correct horse battery staple"
      }
    }

    expect(response).to redirect_to("/account")
    account = Account.find_by!(username: "quiet_vault")
    expect(account.authenticate("correct horse battery staple")).to eq(account)
    expect(account.browser_sessions.count).to eq(1)

    follow_redirect!
    expect(response).to have_http_status(:ok)
    expect(response.body).to include("quiet_vault")
    expect(response.body).not_to include("Vault key")
    expect(response.body).to include(
      "Your Recovery",
      "Phrase protects access to your Vault",
      "cannot",
      "reset or recover the Account password"
    )
  end

  it "changes the Account password and revokes every browser and API session" do
    account = Account.create!(
      username: "quiet_vault",
      password: "old password",
      password_confirmation: "old password",
      last_activity_at: Time.current
    )
    account.browser_sessions.create!(
      client_family: "Other",
      last_activity_at: Time.current
    )
    api_session = account.api_sessions.create!(scope: "Account", confirmed_at: Time.current)
    api_session.session_credentials.create!(
      kind: "Access",
      secret_digest: Digest::SHA256.digest("secret"),
      expires_at: 15.minutes.from_now
    )

    post "/session", params: { username: "quiet_vault", password: "old password" }
    expect(response).to redirect_to("/account")

    patch "/account/password", params: {
      account: {
        current_password: "old password",
        password: "new password",
        password_confirmation: "new password"
      }
    }

    expect(response).to redirect_to("/session/new")
    expect(account.reload.authenticate("new password")).to eq(account)
    expect(account.browser_sessions).to be_empty
    expect(api_session.reload).to be_revoked
    expect(api_session.session_credentials.where(revoked_at: nil)).to be_empty
  end
end
