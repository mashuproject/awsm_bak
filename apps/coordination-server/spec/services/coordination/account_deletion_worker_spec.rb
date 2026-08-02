require "rails_helper"
require "fileutils"

RSpec.describe Coordination::AccountDeletionWorker do
  let(:password) { "correct horse battery staple" }
  let(:account) do
    create_account(
      username: "erase_this",
      password:,
      password_confirmation: password
    )
  end

  def grant(replica:, target: account)
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: target.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
  end

  def add_item(replica:, admitted_by_grant:, contents:)
    storage_key = "objects/#{SecureRandom.uuid}"
    path = Coordination::DiskStore.path(storage_key)
    FileUtils.mkdir_p(path.dirname)
    File.binwrite(path, contents)
    OpaqueStorageItem.create!(
      hosted_replica: replica,
      admitted_by_grant:,
      storage_item_id: Digest::SHA256.digest("item:#{contents}"),
      locator: Digest::SHA256.digest("locator:#{contents}"),
      storage_class: "Compact",
      byte_length: contents.bytesize,
      ciphertext_digest: Digest::SHA256.digest(contents),
      storage_key:,
      inventory_cursor: 1
    )
  end

  def begin_deletion
    Coordination::AccountDeletion.accept_manual!(
      account:,
      password:,
      username_confirmation: account.username
    ).first
  end

  it "reaps a solely granted Hosted Replica before deleting the Host identity" do
    replica = HostedReplica.create!(management_label: "Private mirror")
    access_grant = grant(replica:)
    item = add_item(replica:, admitted_by_grant: access_grant, contents: "opaque bytes".b)
    old_account_id = account.id
    job = begin_deletion

    described_class.perform!(job.id, at: Time.zone.parse("2026-08-02 12:00:00"))

    expect(Account.find_by(id: old_account_id)).to be_nil
    expect(HostedReplica.find_by(id: replica.id)).to be_nil
    expect(Coordination::DiskStore.exists?(item.storage_key)).to be(false)
    expect(job.reload).to have_attributes(
      account_id: nil,
      state: "Succeeded",
      stage: "Complete",
      total_bytes: item.byte_length,
      processed_bytes: item.byte_length,
      completed_at: Time.zone.parse("2026-08-02 12:00:00")
    )
  end

  it "removes only this Account's Grant when another principal retains the Hosted Replica" do
    other = create_account(username: "keep_this")
    replica = HostedReplica.create!(management_label: "Shared mirror")
    account_grant = grant(replica:)
    other_grant = grant(replica:, target: other)
    item = add_item(replica:, admitted_by_grant: account_grant, contents: "shared opaque bytes".b)
    old_account_id = account.id
    job = begin_deletion

    described_class.perform!(job.id)

    expect(Account.find_by(id: old_account_id)).to be_nil
    expect(other.reload).to be_active
    expect(replica.reload).to be_active
    expect(replica.replica_access_grants).to contain_exactly(other_grant)
    expect(Coordination::DiskStore.exists?(item.storage_key)).to be(true)
    expect(item.reload.admitted_by_grant).to be_nil
    expect(job.reload).to have_attributes(
      state: "Succeeded",
      total_bytes: 0,
      processed_bytes: 0
    )
  end

  it "retains the deletion fence and retry state when opaque-byte deletion fails" do
    replica = HostedReplica.create!(management_label: "Retry mirror")
    access_grant = grant(replica:)
    add_item(replica:, admitted_by_grant: access_grant, contents: "retry bytes".b)
    job = begin_deletion
    allow(Coordination::DiskStore).to receive(:delete).and_raise(Errno::EIO)

    expect { described_class.perform!(job.id) }.to raise_error(Errno::EIO)

    expect(account.reload.state).to eq("Deleting")
    expect(account.channel_principal.reload.state).to eq("Revoked")
    expect(job.reload).to have_attributes(
      state: "FailedRetryable",
      stage: "ReapReplicas",
      retry_count: 1,
      error_outcome: "STORAGE_UNAVAILABLE"
    )
  end
end
