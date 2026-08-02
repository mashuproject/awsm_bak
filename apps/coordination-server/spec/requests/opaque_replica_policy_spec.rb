require "rails_helper"
require "active_job/test_helper"

RSpec.describe "opaque Hosted Replica policy", type: :request do
  include ActiveJob::TestHelper
  let(:account) { create_account(username: "host_reader") }
  let(:principal) do
    Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current)
  end
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => SecureRandom.uuid,
      "Authorization" => "Bearer opaque-test-session",
      "Content-Type" => "application/json"
    }
  end

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(principal)
  end

  it "creates one Host-local Replica with an exact immutable managing Grant" do
    post "/api/replicas", params: {}.to_json, headers: headers

    expect(response).to have_http_status(:created)
    expect(response.parsed_body).to match(
      "replica_handle" => String,
      "locator_salt" => match(/\A[A-Za-z0-9_-]{43}\z/),
      "capabilities" => ReplicaAccessGrant::CAPABILITIES,
      "quota_bytes" => nil,
      "stored_bytes" => 0
    )
    replica = HostedReplica.find(response.parsed_body.fetch("replica_handle"))
    expect(response.parsed_body.fetch("locator_salt")).to eq(
      Base64.urlsafe_encode64(replica.locator_salt, padding: false)
    )
    expect(replica.replica_access_grants.sole).to have_attributes(
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES,
      created_by_grant: nil,
      revoked_at: nil
    )
  end

  it "lists every currently granted Replica without labels or Vault semantics" do
    first = create_managed_replica(label: "Private label")
    second = create_managed_replica(label: "Another private label")

    get "/api/replicas", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("replicas").pluck("replica_handle")).to contain_exactly(
      first.id,
      second.id
    )
    expect(response.body).not_to include("Private label", "vault", "generation", account.username)
  end

  it "issues an immutable capability-bounded Grant to another Account principal" do
    replica = create_managed_replica(label: "Shared")
    invited = create_account(username: "invited_reader")

    post "/api/replicas/#{replica.id}/grants", params: {
      username: invited.username,
      capabilities: %w[awsm.replica.hint.read awsm.replica.inventory.read awsm.replica.item.read],
      grantable_capabilities: []
    }.to_json, headers: headers

    expect(response).to have_http_status(:created)
    expect(response.parsed_body).to match(
      "grant_id" => String,
      "replica_handle" => replica.id,
      "username" => invited.username,
      "capabilities" => %w[
        awsm.replica.hint.read
        awsm.replica.inventory.read
        awsm.replica.item.read
      ],
      "grantable_capabilities" => []
    )
    expect(replica.replica_access_grants.find(response.parsed_body.fetch("grant_id"))).to have_attributes(
      channel_principal: invited.channel_principal,
      created_by_grant: replica.replica_access_grants.find_by!(channel_principal: account.channel_principal),
      revoked_at: nil
    )
  end

  it "rejects a Grant issue that loses its active Replica and managing-Grant race" do
    replica = create_managed_replica(label: "Stale manager")
    stale_issuer = replica.replica_access_grants.sole
    target = create_account(username: "race_target")
    stale_issuer.update!(revoked_at: Time.current)
    replica.update!(state: "Reaping")

    expect {
      Coordination::HostedReplicaManagement.issue_grant!(
        issuer: stale_issuer,
        username: target.username,
        capabilities: %w[awsm.replica.item.read],
        grantable_capabilities: []
      )
    }.to raise_error(Coordination::OutcomeError) { |error|
      expect(error.outcome).to eq("replica_not_found")
    }
    expect(replica.replica_access_grants.where(channel_principal: target.channel_principal)).to be_empty
  end

  it "does not disclose an existing Replica or exceed the issuer's delegation ceiling" do
    replica = HostedReplica.create!
    issuer_grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: %w[awsm.replica.item.read awsm.replica.manage],
      grantable_capabilities: %w[awsm.replica.item.read]
    )
    target = create_account(username: "bounded_reader")

    post "/api/replicas/#{replica.id}/grants", params: {
      username: target.username,
      capabilities: %w[awsm.replica.item.write],
      grantable_capabilities: []
    }.to_json, headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("access_denied")
    expect(replica.replica_access_grants).to contain_exactly(issuer_grant)

    stranger = create_account(username: "host_stranger")
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: stranger, confirmed_at: Time.current)
    )
    post "/api/replicas/#{replica.id}/grants", params: {
      username: target.username,
      capabilities: %w[awsm.replica.item.read],
      grantable_capabilities: []
    }.to_json, headers: headers

    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body.fetch("outcome")).to eq("replica_not_found")
  end

  it "revokes an exact Grant without changing a still-shared Hosted Replica" do
    replica = create_managed_replica(label: "Shared")
    invited = create_account(username: "revoked_reader")
    target = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: invited.channel_principal,
      capabilities: %w[awsm.replica.item.read],
      grantable_capabilities: []
    )

    delete "/api/replicas/#{replica.id}/grants/#{target.id}", headers: headers

    expect(response).to have_http_status(:no_content)
    expect(target.reload.revoked_at).to be_present
    expect(replica.reload).to be_active
    expect(replica.hosted_replica_reaping_jobs).to be_empty
    expect(replica.replica_access_grants.where(revoked_at: nil).count).to eq(1)
  end

  it "fences and dispatches reaping when the final active Grant is revoked" do
    replica = create_managed_replica(label: "Final grant")
    target = replica.replica_access_grants.sole

    expect {
      delete "/api/replicas/#{replica.id}/grants/#{target.id}", headers: headers
    }.to have_enqueued_job(ReapHostedReplicaJob)

    expect(response).to have_http_status(:no_content)
    expect(target.reload.revoked_at).to be_present
    expect(replica.reload).to have_attributes(state: "Reaping")
    expect(replica.hosted_replica_reaping_jobs.sole).to have_attributes(
      reason: "NoActiveGrants",
      state: "Pending",
      stage: "Freeze"
    )
  end

  it "does not let a non-managing Grant revoke another principal's Grant" do
    replica = create_managed_replica(label: "Managed elsewhere")
    manager = replica.replica_access_grants.sole
    account_grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: create_account(username: "read_only_actor").channel_principal,
      capabilities: %w[awsm.replica.item.read],
      grantable_capabilities: []
    )
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(
        account: account_grant.channel_principal.account,
        confirmed_at: Time.current
      )
    )

    delete "/api/replicas/#{replica.id}/grants/#{manager.id}", headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("access_denied")
    expect(manager.reload.revoked_at).to be_nil
    expect(account_grant.reload.revoked_at).to be_nil
    expect(replica.reload).to be_active
  end

  it "fences and dispatches explicit Hosted Replica reaping" do
    replica = create_managed_replica(label: "Remove from this Host")
    other = create_account(username: "replica_collaborator")
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: other.channel_principal,
      capabilities: %w[awsm.replica.item.read],
      grantable_capabilities: []
    )

    expect {
      delete "/api/replicas/#{replica.id}", headers: headers
    }.to have_enqueued_job(ReapHostedReplicaJob)

    expect(response).to have_http_status(:accepted)
    job = replica.hosted_replica_reaping_jobs.sole
    expect(response.parsed_body).to eq(
      "replica_handle" => replica.id,
      "state" => "reaping",
      "reaping_job_id" => job.id
    )
    expect(replica.reload).to have_attributes(state: "Reaping")
    expect(replica.replica_access_grants.where(revoked_at: nil)).to be_empty
    expect(job).to have_attributes(
      reason: "Manual",
      state: "Pending",
      stage: "Freeze"
    )
  end

  private

  def create_managed_replica(label:)
    replica = HostedReplica.create!(management_label: label)
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
    replica
  end
end
