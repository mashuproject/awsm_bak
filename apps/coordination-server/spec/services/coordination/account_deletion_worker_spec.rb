require "rails_helper"
require "digest"
require "fileutils"

RSpec.describe Coordination::AccountDeletionWorker do
  let(:account) { create_account(username: "erase_this") }

  def pending_job(for_account = account, receipt: false)
    for_account.update!(state: "Deleting")
    for_account.account_deletion_jobs.create!(
      reason: receipt ? "Manual" : "Inactivity",
      state: "Pending",
      stage: "Freeze",
      receipt_digest: receipt ? Digest::SHA256.digest("receipt") : nil
    )
  end

  def add_unfinished_upload(for_account = account)
    vault_id = SecureRandom.uuid
    vault = for_account.vault_replicas.create!(
      vault_id:,
      **vault_slot_attributes(account: for_account, vault_id:),
      state: "Provisional",
      provisional_expires_at: 1.day.from_now
    )
    create_vault_device_principal(account: for_account, vault:)
    generation_id = SecureRandom.uuid
    generation = vault.vault_generations.create!(
      generation_id:,
      generation_number: 0,
      state: "Candidate"
    )
    object_bytes = "encrypted-object".b
    object_key = "objects/#{SecureRandom.uuid}"
    FileUtils.mkdir_p(Coordination::DiskStore.path(object_key).dirname)
    File.binwrite(Coordination::DiskStore.path(object_key), object_bytes)
    record = vault.opaque_records.create!(
      object_id: generation_id,
      object_type: "VaultGeneration",
      byte_length: object_bytes.bytesize,
      sha256: Digest::SHA256.digest(object_bytes),
      state: "Uploading",
      target_generation_id: generation_id,
      vault_key_epoch_id: vault.active_key_epoch_id,
      storage_key: object_key
    )
    generation.update!(generation_record: record)
    upload = record.create_upload!(
      state: "Open",
      part_size: 1024,
      part_count: 1,
      expires_at: 1.day.from_now,
      last_activity_at: Time.current
    )
    part_bytes = "encrypted-part".b
    part_key = "parts/#{upload.id}/0"
    FileUtils.mkdir_p(Coordination::DiskStore.path(part_key).dirname)
    File.binwrite(Coordination::DiskStore.path(part_key), part_bytes)
    part = upload.upload_parts.create!(
      part_number: 0,
      byte_length: part_bytes.bytesize,
      sha256: Digest::SHA256.digest(part_bytes),
      storage_key: part_key,
      received_at: Time.current
    )

    { vault:, generation:, record:, upload:, part:, object_key:, part_key: }
  end

  it "deletes an empty Account and retains only a bounded succeeded receipt job" do
    old_account_id = account.id
    job = pending_job(account, receipt: true)

    described_class.perform!(job.id, at: Time.zone.parse("2026-07-27 12:00:00"))

    expect(Account.find_by(id: old_account_id)).to be_nil
    expect(job.reload).to have_attributes(
      account_id: nil,
      state: "Succeeded",
      stage: "Complete",
      processed_bytes: 0,
      total_bytes: 0,
      error_outcome: nil,
      receipt_expires_at: Time.zone.parse("2026-07-28 12:00:00")
    )
  end

  it "deletes unfinished upload bytes and the complete synchronized graph without crossing Accounts" do
    owned = add_unfinished_upload
    other_account = create_account(username: "keep_this")
    other = add_unfinished_upload(other_account)
    old_account_id = account.id
    old_vault_id = owned.fetch(:vault).vault_id
    job = pending_job

    described_class.perform!(job.id)

    expect(Account.find_by(id: old_account_id)).to be_nil
    expect(VaultReplica.find_by(vault_id: old_vault_id)).to be_nil
    expect(Coordination::DiskStore.exists?(owned.fetch(:object_key))).to be(false)
    expect(Coordination::DiskStore.exists?(owned.fetch(:part_key))).to be(false)
    expect(other_account.reload).to be_active
    expect(other.fetch(:record).reload.storage_key).to eq(other.fetch(:object_key))
    expect(Coordination::DiskStore.exists?(other.fetch(:object_key))).to be(true)
    expect(Coordination::DiskStore.exists?(other.fetch(:part_key))).to be(true)
    expect(job.reload.processed_bytes).to eq(
      "encrypted-object".bytesize + "encrypted-part".bytesize
    )
  end

  it "treats already-missing bytes as idempotently deleted" do
    owned = add_unfinished_upload
    File.delete(Coordination::DiskStore.path(owned.fetch(:object_key)))
    File.delete(Coordination::DiskStore.path(owned.fetch(:part_key)))
    job = pending_job

    described_class.perform!(job.id)

    expect(job.reload).to have_attributes(state: "Succeeded", stage: "Complete")
  end

  it "retains the deletion fence and retry state after storage failure, then resumes" do
    owned = add_unfinished_upload
    job = pending_job
    allow(Coordination::DiskStore).to receive(:delete).and_raise(Errno::EIO)

    expect { described_class.perform!(job.id) }.to raise_error(Errno::EIO)

    expect(account.reload.state).to eq("Deleting")
    expect(job.reload).to have_attributes(
      state: "FailedRetryable",
      stage: "DeleteOpaqueBytes",
      retry_count: 1,
      error_outcome: "STORAGE_UNAVAILABLE"
    )
    expect(owned.fetch(:record).reload.storage_key).to eq(owned.fetch(:object_key))
  end

  it "never removes relational state when byte absence cannot be verified" do
    owned = add_unfinished_upload
    job = pending_job
    allow(Coordination::DiskStore).to receive(:delete).and_return(:deleted)
    allow(Coordination::DiskStore).to receive(:exists?).and_return(true)

    expect { described_class.perform!(job.id) }.to raise_error(
      Coordination::AccountDeletionWorker::DeletionVerificationFailed
    )

    expect(account.reload.state).to eq("Deleting")
    expect(job.reload).to have_attributes(
      state: "FailedRetryable",
      stage: "DeleteOpaqueBytes",
      error_outcome: "DELETE_VERIFICATION_FAILED"
    )
    expect(owned.fetch(:record).reload).to be_present
  end

  it "releases username and Vault identity only after verified completion" do
    owned = add_unfinished_upload
    original_id = account.id
    username = account.username
    vault_id = owned.fetch(:vault).vault_id
    job = pending_job

    expect {
      create_account(username:)
    }.to raise_error(ActiveRecord::RecordInvalid)
    expect {
      create_account(username: "another_owner").vault_replicas.create!(
        vault_id:,
        state: "Provisional",
        head_cursor: 0
      )
    }.to raise_error(ActiveRecord::RecordInvalid)

    described_class.perform!(job.id)

    replacement = create_account(username:)
    expect(replacement.id).not_to eq(original_id)
    expect {
      replacement.vault_replicas.create!(
        vault_id:,
        **vault_slot_attributes(account: replacement, vault_id:),
        state: "Provisional",
        provisional_expires_at: 1.day.from_now
      )
    }.to change(VaultReplica, :count).by(1)
  end
end
