require "rails_helper"

RSpec.describe "canonical Account and Hosted Replica dashboard", type: :request do
  let(:password) { "correct horse battery staple" }
  let(:account) do
    create_account(
      username: "quiet_replica",
      password:,
      password_confirmation: password,
      last_activity_at: Time.utc(2026, 8, 1, 12)
    )
  end

  def sign_in
    post "/session",
      params: { username: account.username, password: },
      headers: { "User-Agent" => "Mozilla/5.0 Firefox/140.0" }
    expect(response).to redirect_to("/account")
    account.channel_principal.browser_sessions.order(:created_at).last
  end

  def grant(replica:, principal:, capabilities: ReplicaAccessGrant::CAPABILITIES)
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: principal,
      capabilities:,
      grantable_capabilities: capabilities
    )
  end

  it "renders Host-local identity and access management without Vault or email concepts" do
    sign_in

    get "/account"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to eq("private, no-store")
    expect(response.body).to include(
      "Account overview",
      "Authenticators",
      "Hosted Replicas",
      "Access Grants",
      "Website sessions",
      "Delete Account",
      "quiet_replica",
      "No Hosted Replicas"
    )
    expect(response.body).not_to include(
      "Devices",
      "Recovery Phrase",
      "Vault state",
      "Vault Member",
      "synchronized Vault"
    )
    expect(Nokogiri::HTML(response.body).css('input[type="email"]')).to be_empty
  end

  it "shows every granted Hosted Replica, exact capabilities, quota, and co-principal Grants" do
    collaborator = create_account(username: "trusted_peer")
    primary = HostedReplica.create!(
      management_label: "Archive mirror",
      quota_bytes: 10.megabytes,
      stored_bytes: 2.megabytes
    )
    secondary = HostedReplica.create!(management_label: "Travel copy")
    grant(replica: primary, principal: account.channel_principal)
    grant(
      replica: primary,
      principal: collaborator.channel_principal,
      capabilities: %w[awsm.replica.inventory.read awsm.replica.item.read]
    )
    grant(
      replica: secondary,
      principal: account.channel_principal,
      capabilities: %w[awsm.replica.inventory.read awsm.replica.item.read]
    )
    sign_in

    get "/account"

    expect(response.body).to include(
      "Archive mirror",
      "Travel copy",
      primary.id,
      secondary.id,
      "2 MB of 10 MB",
      "Inventory read",
      "Item read",
      "Item write",
      "Hint read",
      "Hint write",
      "Manage access",
      "trusted_peer"
    )
    expect(response.body).not_to include("Vault ID", "Generation", "Event", "Key Epoch")
  end

  it "shows the password authenticator without exposing its digest" do
    sign_in
    authenticator = account.channel_principal.password_authenticator.reload

    get "/account"

    expect(response.body).to include("Password", "Active", "Last used")
    expect(response.body).not_to include(authenticator.password_digest)
    expect(authenticator.last_used_at).to be_within(2.seconds).of(Time.current)
  end

  it "revokes another website session while preserving the current session" do
    current = sign_in
    other = account.channel_principal.browser_sessions.create!(
      client_family: "Chrome",
      last_activity_at: 2.days.ago
    )

    delete "/account/browser-sessions/#{other.id}"

    expect(response).to redirect_to("/account#website-sessions")
    expect(account.channel_principal.browser_sessions.reload).to contain_exactly(current)
  end

  it "lists and revokes API sessions without exposing bearer credentials" do
    api_session = account.channel_principal.api_sessions.create!(confirmed_at: 1.day.ago)
    credential = api_session.session_credentials.create!(
      kind: "Access",
      secret_digest: Digest::SHA256.digest("never render this bearer secret"),
      expires_at: 1.day.from_now
    )
    sign_in

    get "/account"

    expect(response.body).to include("API sessions", "Active", api_session.id)
    expect(response.body).not_to include(credential.secret_digest)

    delete "/account/api-sessions/#{api_session.id}"

    expect(response).to redirect_to("/account#api-sessions")
    expect(api_session.reload).to be_revoked
    expect(credential.reload.revoked_at).to be_present
  end

  it "replaces the password authenticator and revokes every Account session" do
    old_authenticator = account.channel_principal.password_authenticator
    other_browser = account.channel_principal.browser_sessions.create!(
      client_family: "Chrome",
      last_activity_at: 2.days.ago
    )
    api_session = account.channel_principal.api_sessions.create!(confirmed_at: 1.day.ago)
    api_credential = api_session.session_credentials.create!(
      kind: "Access",
      secret_digest: Digest::SHA256.digest("replace me"),
      expires_at: 1.day.from_now
    )
    sign_in

    patch "/account/password", params: {
      account: {
        current_password: password,
        password: "new private password",
        password_confirmation: "new private password"
      }
    }

    expect(response).to redirect_to("/session/new")
    expect(account.reload.authenticate("new private password")).to be(account)
    expect(account.authenticate(password)).to be(false)
    expect(old_authenticator.reload.revoked_at).to be_present
    expect(account.channel_principal.password_authenticator.id).not_to eq(old_authenticator.id)
    expect(BrowserSession.exists?(other_browser.id)).to be(false)
    expect(api_session.reload).to be_revoked
    expect(api_credential.reload.revoked_at).to be_present
  end
end
