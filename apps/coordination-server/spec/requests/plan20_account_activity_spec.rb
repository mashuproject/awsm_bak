require "rails_helper"

RSpec.describe "Plan 20 Account activity", type: :request do
  let(:account) { create_account(last_activity_at: 3.days.ago) }
  let(:issued) { Coordination::SessionCredentials.issue(account:, scope: "Account") }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => SecureRandom.uuid,
      "Authorization" => "Bearer #{issued.fetch(:access_token)}"
    }
  end

  it "refreshes activity after a successful authenticated API request" do
    previous = account.last_activity_at

    get "/api/service-policy", headers: headers

    expect(response).to have_http_status(:ok)
    expect(account.reload.last_activity_at).to be > previous
    expect(account.last_activity_at).to be_within(5.seconds).of(Time.current)
  end

  it "does not refresh activity after an authenticated authorization failure" do
    previous = account.last_activity_at

    get "/api/vaults", headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(account.reload.last_activity_at).to eq(previous)
  end

  it "rejects credential issue, authentication, and refresh for a Deleting Account" do
    access_token = issued.fetch(:access_token)
    refresh_token = issued.fetch(:refresh_token)
    account.update!(state: "Deleting")

    expect {
      Coordination::SessionCredentials.issue(account:, scope: "Account")
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("AUTHENTICATION_FAILED")
    }
    expect {
      Coordination::SessionCredentials.authenticate(access_token)
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("AUTHENTICATION_FAILED")
    }
    expect {
      Coordination::SessionCredentials.refresh(refresh_token)
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("AUTHENTICATION_FAILED")
    }
  end

  it "rechecks Account state after browser authentication and creates no BrowserSession" do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate_login).and_return(account)
    account.update!(state: "Deleting")

    post "/session", params: { username: account.username, password: "accepted-before-freeze" }

    expect(response).to have_http_status(:unprocessable_content)
    expect(account.browser_sessions).to be_empty
    expect(response.body).to include("That username or password is incorrect.")
  end

  it "rechecks Account state after API authentication and performs no mutation" do
    vault = account.vault_replicas.create!(
      vault_id: SecureRandom.uuid,
      state: "Active",
      head_cursor: 0
    )
    principal = create_vault_device_principal(account:, vault:)
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(principal)
    allow(Coordination::CableTickets).to receive(:issue)
    request_headers = headers
    account.update!(state: "Deleting")

    post "/api/cable-tickets", headers: request_headers

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHENTICATION_FAILED")
    expect(Coordination::CableTickets).not_to have_received(:issue)
  end
end
