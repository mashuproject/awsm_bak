require "rails_helper"

RSpec.describe "canonical Replica Host policy schema", type: :model do
  let(:connection) { ActiveRecord::Base.connection }

  it "contains only Host-local identity, access, storage, and lifecycle resources" do
    expect(connection.data_source_exists?("channel_principals")).to be(true)
    expect(connection.data_source_exists?("channel_authenticators")).to be(true)
    expect(connection.data_source_exists?("hosted_replicas")).to be(true)
    expect(connection.data_source_exists?("replica_access_grants")).to be(true)
    expect(connection.data_source_exists?("opaque_storage_items")).to be(true)
    expect(connection.data_source_exists?("opaque_uploads")).to be(true)
    expect(connection.data_source_exists?("opaque_upload_parts")).to be(true)
    expect(connection.data_source_exists?("hosted_replica_reaping_jobs")).to be(true)

    expect(connection.data_source_exists?("vault_replicas")).to be(false)
    expect(connection.data_source_exists?("vault_generations")).to be(false)
    expect(connection.data_source_exists?("vault_devices")).to be(false)
    expect(connection.data_source_exists?("vault_key_epochs")).to be(false)
    expect(connection.data_source_exists?("recovery_generations")).to be(false)
    expect(connection.data_source_exists?("device_key_envelopes")).to be(false)
    expect(connection.data_source_exists?("event_commits")).to be(false)
    expect(connection.data_source_exists?("record_dependencies")).to be(false)
    expect(connection.data_source_exists?("generation_memberships")).to be(false)
    expect(connection.data_source_exists?("generation_reachability_pages")).to be(false)
    expect(connection.data_source_exists?("generation_reachability_entries")).to be(false)
    expect(connection.data_source_exists?("delivery_changes")).to be(false)
    expect(connection.data_source_exists?("purge_jobs")).to be(false)
    expect(connection.data_source_exists?("purge_job_generations")).to be(false)
  end

  it "keeps passwords in a typed Channel Authenticator and creates no Vault binding" do
    account = Account.create!(
      username: "private_reader",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )

    expect(Account.column_names).not_to include("email", "password_digest")
    expect(account.channel_principal.principal_type).to eq("Account")
    expect(account.channel_principal.channel_authenticators.map(&:authenticator_type))
      .to contain_exactly("Password")
    expect(account.authenticate("correct horse battery staple")).to be(account)
    expect(account.authenticate("wrong password")).to be(false)
    expect(account).not_to respond_to(:vault_replicas)
  end

  it "binds access through immutable capability Grants instead of ownership" do
    account = Account.create!(
      username: "replica_reader",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )
    replica = HostedReplica.create!(quota_bytes: 1_048_576)
    grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )

    expect(replica).not_to respond_to(:account_id)
    expect(replica).not_to respond_to(:vault_id)
    expect(grant.capabilities).to contain_exactly(*ReplicaAccessGrant::CAPABILITIES)
    expect(account.hosted_replicas).to contain_exactly(replica)
  end
end
