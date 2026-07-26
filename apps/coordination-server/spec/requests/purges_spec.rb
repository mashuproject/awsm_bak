require "rails_helper"
require "digest"
require "fileutils"

RSpec.describe "Recovery purge safety", type: :request do
  let(:account) { create_account }
  let(:vault_id) { "01900000-0000-7000-8000-000000000060" }
  let(:old_generation_id) { "01900000-0000-7000-8000-000000000061" }
  let(:active_generation_id) { "01900000-0000-7000-8000-000000000062" }
  let(:shared_id) { "01900000-0000-7000-8000-000000000063" }
  let(:retired_id) { "01900000-0000-7000-8000-000000000064" }
  let(:headers) do
    { "Awsm-Protocol-Version" => "1",
     "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000065",
     "Authorization" => "Bearer proof",
     "Idempotency-Key" => "01900000-0000-7000-8000-000000000066" }
  end
  let!(:vault) { vault_with_recovery }

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      create_vault_device_principal(account:, vault:)
    )
  end

  it "durably snapshots a non-cancellable purge and deletes only newly unreferenced bytes" do
    post "/api/vaults/#{vault_id}/purges", headers: headers

    expect(response).to have_http_status(:accepted)
    purge = PurgeJob.find(response.parsed_body.fetch("purgeId"))
    expect(purge.vault_generations.pluck(:generation_id)).to eq([ old_generation_id ])
    expect(VaultGeneration.find_by!(generation_id: old_generation_id).state).to eq("Purging")

    PurgeGenerationJob.perform_now(purge.id)

    expect(purge.reload.state).to eq("Succeeded")
    expect(OpaqueRecord.find_by!(object_id: shared_id).state).to eq("Committed")
    retired = OpaqueRecord.find_by!(object_id: retired_id)
    expect(retired.state).to eq("Purged")
    expect(retired.storage_key).to be_nil
    expect(File.exist?(Coordination::DiskStore.path("objects/#{retired_id}"))).to be(false)
    expect(VaultGeneration.find_by!(generation_id: old_generation_id).state).to eq("Purged")
  end

  it "requires recent authentication before beginning irreversible deletion" do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      create_vault_device_principal(account:, vault:).then do |principal|
        Coordination::AccountPrincipal.new(
          account: principal.account,
          confirmed_at: 1.hour.ago,
          session: principal.session,
          scope: principal.scope
        )
      end
    )

    post "/api/vaults/#{vault_id}/purges", headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("RECENT_AUTHENTICATION_REQUIRED")
    expect(PurgeJob.count).to eq(0)
  end

  it "retains its deletion snapshot and resumes after storage failure" do
    post "/api/vaults/#{vault_id}/purges", headers: headers
    purge = PurgeJob.find(response.parsed_body.fetch("purgeId"))
    failed_once = false
    allow(File).to receive(:delete).and_wrap_original do |original, path|
      unless failed_once
        failed_once = true
        raise Errno::EIO, path.to_s
      end
      original.call(path)
    end

    expect { PurgeGenerationJob.perform_now(purge.id) }.to raise_error(Errno::EIO)
    expect(purge.reload.state).to eq("FailedRetryable")
    expect(purge.vault_generations.first.generation_memberships.count).to eq(2)

    PurgeGenerationJob.perform_now(purge.id)

    expect(purge.reload.state).to eq("Succeeded")
    expect(OpaqueRecord.find_by!(object_id: retired_id).state).to eq("Purged")
  end

  private

  def vault_with_recovery
    replica = account.vault_replicas.create!(vault_id:, **vault_slot_attributes(account:, vault_id:),
      state: "Active", head_cursor: 3,
      active_generation_number: 1)
    create_vault_device_principal(account:, vault: replica)
    old_generation = replica.vault_generations.create!(generation_id: old_generation_id,
      generation_number: 0, state: "Superseded", activated_at: 2.days.ago,
      superseded_at: 1.day.ago, purge_after: 89.days.from_now)
    active_generation = replica.vault_generations.create!(generation_id: active_generation_id,
      generation_number: 1, predecessor_generation: old_generation, state: "Active",
      activated_at: 1.day.ago)
    replica.update!(active_generation: active_generation)
    shared = committed_record(replica, shared_id)
    retired = committed_record(replica, retired_id)
    old_generation.generation_memberships.create!(opaque_record: shared)
    old_generation.generation_memberships.create!(opaque_record: retired)
    active_generation.generation_memberships.create!(opaque_record: shared)
    replica
  end

  def committed_record(replica, object_id)
    key = "objects/#{object_id}"
    FileUtils.mkdir_p(Coordination::DiskStore.path(key).dirname)
    File.binwrite(Coordination::DiskStore.path(key), object_id)
    replica.opaque_records.create!(object_id:, object_type: "Artifact", byte_length: object_id.bytesize,
      sha256: Digest::SHA256.digest(object_id), state: "Committed",
      target_generation_id: old_generation_id, storage_key: key,
      durable_at: Time.current, committed_at: Time.current,
      vault_key_epoch_id: replica.active_key_epoch_id)
  end
end
