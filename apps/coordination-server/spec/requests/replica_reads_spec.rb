require "rails_helper"
require "digest"
require "fileutils"

RSpec.describe "Active replica reads", type: :request do
  let(:account) { create_account }
  let(:vault_id) { "01900000-0000-7000-8000-000000000040" }
  let(:generation_id) { "01900000-0000-7000-8000-000000000041" }
  let(:event_id) { "01900000-0000-7000-8000-000000000042" }
  let(:bytes) { "encrypted-event".b }
  let(:headers) do
    { "Awsm-Protocol-Version" => "1",
     "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000043",
     "Authorization" => "Bearer proof" }
  end
  let!(:vault) { active_vault_with_event }

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      create_vault_device_principal(account:, vault:)
    )
  end

  it "enumerates only active Generation membership in lexical Object-ID order" do
    get "/api/vaults/#{vault_id}/records", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("generationId" => generation_id, "hasMore" => false)
    expect(response.parsed_body.fetch("records").map { |record| record.fetch("objectId") }).to eq([ event_id ])
  end

  it "returns snapshot-bounded delivery changes and fences a stale Generation" do
    get "/api/vaults/#{vault_id}/changes", params: { after: 0, limit: 100 }, headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("nextCursor" => 2, "snapshotCursor" => 2,
                                            "hasMore" => false)
    expect(response.parsed_body.fetch("changes").last).to include("cursor" => 2,
                                                                  "kind" => "EventCommitted")

    get "/api/vaults/#{vault_id}/changes",
      params: { after: 0, generationId: "01900000-0000-7000-8000-000000000049" }, headers: headers
    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("VAULT_GENERATION_SUPERSEDED")
    expect(response.parsed_body.slice("currentGenerationId", "currentGenerationNumber", "headCursor"))
      .to eq("currentGenerationId" => generation_id, "currentGenerationNumber" => 0,
        "headCursor" => 2)
  end

  it "keeps later change pages fenced when the server head advances" do
    get "/api/vaults/#{vault_id}/changes", params: { after: 0, limit: 1 }, headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("nextCursor" => 1, "snapshotCursor" => 2,
                                            "hasMore" => true)
    vault.update!(head_cursor: 3)
    DeliveryChange.create!(vault_replica: vault, vault_generation: vault.active_generation,
      cursor: 3, kind: "GenerationActivated", accepted_at: Time.current)

    get "/api/vaults/#{vault_id}/changes",
      params: { after: 1, limit: 100, snapshot: 2 }, headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("nextCursor" => 2, "snapshotCursor" => 2,
                                            "hasMore" => false)
    expect(response.parsed_body.fetch("changes").map { |change| change.fetch("cursor") }).to eq([ 2 ])
  end

  it "issues an active-only ticket and serves a single verified byte range" do
    post "/api/vaults/#{vault_id}/records/#{event_id}/downloads", headers: headers.merge(
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000044"
    )
    expect(response).to have_http_status(:ok)
    path = response.parsed_body.dig("ticket", "url")

    get path, headers: {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000045",
      "Range" => "bytes=2-6"
    }

    expect(response).to have_http_status(:partial_content)
    expect(response.body.b).to eq(bytes.byteslice(2..6))
    expect(response.headers.fetch("Content-Range")).to eq("bytes 2-6/#{bytes.bytesize}")
    expect(response.headers.fetch("ETag")).to eq(%("#{Coordination::ProtocolEncoding.encode_sha256(Digest::SHA256.digest(bytes))}"))
  end

  private

  def active_vault_with_event
    replica = account.vault_replicas.create!(vault_id:, **vault_slot_attributes(account:, vault_id:),
      state: "Active", head_cursor: 2,
      active_generation_number: 0)
    create_vault_device_principal(account:, vault: replica)
    generation = replica.vault_generations.create!(generation_id:, generation_number: 0,
      state: "Active", activated_at: Time.current)
    replica.update!(active_generation: generation)
    key = "objects/#{event_id.first(2)}/#{event_id}"
    FileUtils.mkdir_p(Coordination::DiskStore.path(key).dirname)
    File.binwrite(Coordination::DiskStore.path(key), bytes)
    event = replica.opaque_records.create!(object_id: event_id, object_type: "Event",
      byte_length: bytes.bytesize, sha256: Digest::SHA256.digest(bytes), state: "Committed",
      target_generation_id: generation_id, event_ordering_timestamp: Time.utc(2026, 7, 19, 12),
      durable_at: Time.current, committed_at: Time.current, storage_key: key,
      vault_key_epoch_id: replica.active_key_epoch_id)
    generation.generation_memberships.create!(opaque_record: event)
    commit = EventCommit.create!(vault_replica: replica, vault_generation: generation,
      event_record: event, cursor: 2, request_sha256: Digest::SHA256.digest("commit"),
      committed_at: Time.current)
    DeliveryChange.create!(vault_replica: replica, vault_generation: generation,
      cursor: 1, kind: "GenerationActivated", accepted_at: 1.minute.ago)
    DeliveryChange.create!(vault_replica: replica, vault_generation: generation,
      event_commit: commit, cursor: 2, kind: "EventCommitted", accepted_at: Time.current)
    replica
  end
end
