require "rails_helper"

RSpec.describe "Cable tickets", type: :request do
  let(:account) { create_account }
  let(:vault) do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000081",
      state: "Active",
      head_cursor: 0
    )
  end
  let(:principal) { create_vault_device_principal(account:, vault:) }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000082",
      "Authorization" => "Bearer test"
    }
  end

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      principal
    )
  end

  it "issues the canonical opaque one-use credential" do
    post "/api/cable-tickets", headers: headers

    expect(response).to have_http_status(:created)
    raw_ticket = response.parsed_body.fetch("ticket")
    expect(raw_ticket).to match(/\A[A-Za-z0-9_-]{43}\z/)
    expect(response.parsed_body.fetch("expiresAt")).to be_present

    expect(Coordination::CableTickets.consume(raw_ticket)).to eq(account)
    expect { Coordination::CableTickets.consume(raw_ticket) }
      .to raise_error(Coordination::OutcomeError, /AUTHENTICATION_FAILED/)
  end

  it "rejects an unconsumed ticket after Device session revocation" do
    post "/api/cable-tickets", headers: headers
    raw_ticket = response.parsed_body.fetch("ticket")
    principal.session.revoke!

    expect { Coordination::CableTickets.consume(raw_ticket) }
      .to raise_error(Coordination::OutcomeError, /AUTHENTICATION_FAILED/)
  end

  it "returns the stable retryable outcome when ephemeral coordination is unavailable" do
    allow(Coordination::EphemeralCoordination).to receive(:with_redis)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")
    allow(Rails.error).to receive(:report)

    post "/api/cable-tickets", headers: headers

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body).to eq(
      "outcome" => "AUTHENTICATION_UNAVAILABLE",
      "retryable" => true,
      "requestId" => headers.fetch("Awsm-Request-ID")
    )
    expect(response.body).not_to include("credential-sentinel")
  end
end
