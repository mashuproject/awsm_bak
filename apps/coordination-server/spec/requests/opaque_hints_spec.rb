require "rails_helper"

RSpec.describe "opaque Hosted Replica Wake Hints", type: :request do
  let(:account) { create_account(username: "hint_writer") }
  let(:principal) { Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current) }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => SecureRandom.uuid,
      "Authorization" => "Bearer hint-test-session"
    }
  end
  let(:replica) { HostedReplica.create! }
  let!(:grant) do
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
  end

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(principal)
  end

  it "reads and explicitly advances only the advisory cursor" do
    get "/api/replicas/#{replica.id}/hint", headers: headers
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("hint_cursor" => 0)

    post "/api/replicas/#{replica.id}/hint", params: {}, as: :json, headers: headers
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("hint_cursor" => 1)
    expect(replica.reload).to have_attributes(
      hint_cursor: 1,
      inventory_cursor: 0,
      stored_bytes: 0
    )
  end

  it "separates read and write capabilities without disclosing another Replica" do
    reader = create_account(username: "hint_reader")
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: reader.channel_principal,
      capabilities: %w[awsm.replica.hint.read],
      grantable_capabilities: []
    )
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: reader, confirmed_at: Time.current)
    )

    get "/api/replicas/#{replica.id}/hint", headers: headers
    expect(response).to have_http_status(:ok)
    post "/api/replicas/#{replica.id}/hint", params: {}, as: :json, headers: headers
    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("access_denied")

    stranger = create_account(username: "hint_stranger")
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: stranger, confirmed_at: Time.current)
    )
    get "/api/replicas/#{replica.id}/hint", headers: headers
    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body.fetch("outcome")).to eq("replica_not_found")
  end
end
