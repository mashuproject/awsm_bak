require "rails_helper"
require "fileutils"

RSpec.describe "canonical Hosted Replica reaping" do
  def account_with_replica(username:)
    account = create_account(username:)
    replica = HostedReplica.create!(management_label: username)
    grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
    [ account, replica, grant ]
  end

  def add_item(replica:, grant:, contents:)
    storage_key = "objects/#{SecureRandom.uuid}"
    path = Coordination::DiskStore.path(storage_key)
    FileUtils.mkdir_p(path.dirname)
    File.binwrite(path, contents)
    OpaqueStorageItem.create!(
      hosted_replica: replica,
      admitted_by_grant: grant,
      storage_item_id: Digest::SHA256.digest("item:#{contents}"),
      storage_class: "Compact",
      byte_length: contents.bytesize,
      ciphertext_digest: Digest::SHA256.digest(contents),
      storage_key:,
      inventory_cursor: 1
    )
  end

  it "refuses to reap while any active Replica Access Grant remains" do
    _account, replica, _grant = account_with_replica(username: "still_granted")
    job = HostedReplicaReapingJob.create!(
      hosted_replica: replica,
      reason: "Manual",
      state: "Pending",
      stage: "Freeze"
    )

    expect {
      Coordination::HostedReplicaReaper.perform!(job.id)
    }.to raise_error(Coordination::HostedReplicaReaper::ActiveGrantPresent)

    expect(replica.reload).to be_active
    expect(job.reload).to have_attributes(
      state: "FailedRetryable",
      stage: "Freeze",
      error_outcome: "ACTIVE_GRANT_PRESENT",
      retry_count: 1
    )
  end

  it "deletes only the orphan Replica's verified bytes and retains a terminal outcome" do
    _account, replica, grant = account_with_replica(username: "reap_this")
    item = add_item(replica:, grant:, contents: "opaque orphan bytes".b)
    _other_account, other_replica, other_grant = account_with_replica(username: "keep_this")
    other = add_item(replica: other_replica, grant: other_grant, contents: "opaque retained bytes".b)
    grant.update!(revoked_at: Time.current)
    replica.update!(state: "Reaping")
    job = HostedReplicaReapingJob.create!(
      hosted_replica: replica,
      reason: "NoActiveGrants",
      state: "Pending",
      stage: "Freeze"
    )

    Coordination::HostedReplicaReaper.perform!(job.id, at: Time.zone.parse("2026-08-02 12:00:00"))

    expect(HostedReplica.find_by(id: replica.id)).to be_nil
    expect(Coordination::DiskStore.exists?(item.storage_key)).to be(false)
    expect(other_replica.reload).to be_active
    expect(Coordination::DiskStore.exists?(other.storage_key)).to be(true)
    expect(job.reload).to have_attributes(
      hosted_replica_id: nil,
      state: "Succeeded",
      stage: "Complete",
      total_bytes: item.byte_length,
      processed_bytes: item.byte_length,
      completed_at: Time.zone.parse("2026-08-02 12:00:00")
    )
  end
end
