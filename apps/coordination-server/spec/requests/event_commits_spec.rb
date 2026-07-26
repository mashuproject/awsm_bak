require "rails_helper"
require "base64"
require "digest"

RSpec.describe "One-Event closure commits", type: :request do
  let(:account) { create_account }
  let(:vault_id) { "01900000-0000-7000-8000-000000000030" }
  let(:generation_id) { "01900000-0000-7000-8000-000000000031" }
  let(:artifact_id) { "01900000-0000-7000-8000-000000000032" }
  let(:event_id) { "01900000-0000-7000-8000-000000000033" }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000034",
      "Authorization" => "Bearer proof",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000035",
      "Content-Type" => "application/json"
    }
  end
  let!(:vault) { active_vault }

  before do
    principal = create_vault_device_principal(account:, vault:)
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      principal
    )
  end

  it "binds sorted Event dependencies at upload creation" do
    durable_record(artifact_id, "Artifact")
    event_bytes = "event"
    post "/api/vaults/#{vault_id}/uploads", params: {
      objectId: event_id, objectType: "Event", byteLength: event_bytes.bytesize,
      keyEpochId: vault.active_key_epoch_id,
      sha256: encoded_sha(event_bytes), targetGenerationId: generation_id,
      eventMetadata: { orderingTimestamp: "2026-07-19T12:00:00.000Z",
                      dependencyObjectIds: [ artifact_id ] }
    }.to_json, headers: headers

    expect(response).to have_http_status(:created)
    event = OpaqueRecord.find_by!(object_id: event_id)
    expect(event.record_dependencies.first.dependency_record.object_id).to eq(artifact_id)
  end

  it "rejects unsorted or duplicate dependency declarations" do
    second_id = "01900000-0000-7000-8000-000000000036"
    durable_record(artifact_id, "Artifact")
    durable_record(second_id, "Artifact")

    post "/api/vaults/#{vault_id}/uploads", params: {
      objectId: event_id, objectType: "Event", byteLength: 5,
      keyEpochId: vault.active_key_epoch_id,
      sha256: encoded_sha("event"), targetGenerationId: generation_id,
      eventMetadata: { orderingTimestamp: "2026-07-19T12:00:00.000Z",
                      dependencyObjectIds: [ second_id, artifact_id ] }
    }.to_json, headers: headers

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("DEPENDENCY_INVALID")
    expect(OpaqueRecord.find_by(object_id: event_id)).to be_nil
  end

  it "rejects an upload declared under a stale or unknown key epoch" do
    post "/api/vaults/#{vault_id}/uploads", params: {
      objectId: event_id,
      objectType: "Event",
      keyEpochId: "01900000-0000-7000-8000-000000000099",
      byteLength: 5,
      sha256: encoded_sha("event"),
      targetGenerationId: generation_id,
      eventMetadata: {
        orderingTimestamp: "2026-07-19T12:00:00.000Z",
        dependencyObjectIds: []
      }
    }.to_json, headers: headers

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("KEY_EPOCH_CHANGED")
    expect(OpaqueRecord.find_by(object_id: event_id)).to be_nil
  end

  it "publishes the exact durable closure atomically at one cursor" do
    artifact = durable_record(artifact_id, "Artifact")
    event = durable_record(event_id, "Event", dependencies: [ artifact ])
    body = { generationId: generation_id, generationNumber: 0, eventObjectId: event_id,
            dependencyObjectIds: [ artifact_id ] }

    post "/api/vaults/#{vault_id}/commits", params: body.to_json, headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("eventObjectId" => event_id, "cursor" => 2,
                                            "durabilityAcknowledged" => true)
    expect(event.reload.state).to eq("Committed")
    expect(artifact.reload.state).to eq("Committed")
    expect(vault.active_generation.opaque_records.where(object_id: [ event_id, artifact_id ]).count).to eq(2)
    expect(DeliveryChange.find_by!(cursor: 2).event_commit.event_record).to eq(event)

    post "/api/vaults/#{vault_id}/commits", params: body.to_json, headers: headers
    expect(response.parsed_body.fetch("cursor")).to eq(2)
    expect(vault.reload.head_cursor).to eq(2)
  end

  it "accepts an already-committed closure retained by the active successor" do
    artifact = durable_record(artifact_id, "Artifact")
    event = durable_record(event_id, "Event", dependencies: [ artifact ])
    predecessor_body = { generationId: generation_id, generationNumber: 0, eventObjectId: event_id,
                         dependencyObjectIds: [ artifact_id ] }
    post "/api/vaults/#{vault_id}/commits", params: predecessor_body.to_json, headers: headers
    expect(response).to have_http_status(:ok)

    predecessor = vault.active_generation
    predecessor.update!(state: "Superseded", superseded_at: Time.current)
    successor = vault.vault_generations.create!(
      generation_id: "01900000-0000-7000-8000-000000000037", generation_number: 1,
      predecessor_generation: predecessor, state: "Active", activated_at: Time.current
    )
    successor.generation_memberships.create!(opaque_record: artifact)
    successor.generation_memberships.create!(opaque_record: event)
    vault.update!(active_generation: successor, active_generation_number: 1)

    post "/api/vaults/#{vault_id}/commits", params: {
      generationId: successor.generation_id, generationNumber: 1, eventObjectId: event_id,
      dependencyObjectIds: [ artifact_id ]
    }.to_json, headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000038")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include(
      "generationId" => successor.generation_id, "generationNumber" => 1,
      "cursor" => 2, "durabilityAcknowledged" => true
    )
    expect(vault.reload.head_cursor).to eq(2)
    expect(DeliveryChange.where(vault_replica: vault).count).to eq(1)
  end

  it "keeps a committed Event pollable when Redis hint publication fails" do
    event = durable_record(event_id, "Event")
    allow(VaultChangesChannel).to receive(:broadcast_to)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")
    expect(Rails.error).to receive(:report) do |error, handled:, context:|
      expect(error.message).to eq("ephemeral_coordination_unavailable")
      expect(handled).to be(true)
      expect(context).to eq(component: "vault_change_hint")
      expect([ error, context ].inspect).not_to include("credential-sentinel")
    end

    post "/api/vaults/#{vault_id}/commits", params: {
      generationId: generation_id,
      generationNumber: 0,
      eventObjectId: event_id,
      dependencyObjectIds: []
    }.to_json, headers: headers

    expect(response).to have_http_status(:ok)
    expect(event.reload.state).to eq("Committed")

    get "/api/vaults/#{vault_id}/changes?after=1&limit=100",
      headers: headers.except("Idempotency-Key", "Content-Type")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("changes").sole.dig("event", "objectId")).to eq(event_id)
  end

  private

  def active_vault
    replica = account.vault_replicas.create!(vault_id:, **vault_slot_attributes(account:, vault_id:),
      state: "Active", head_cursor: 1,
      active_generation_number: 0)
    generation = replica.vault_generations.create!(generation_id:, generation_number: 0,
      state: "Active", activated_at: Time.current)
    replica.update!(active_generation: generation)
    replica
  end

  def durable_record(object_id, object_type, dependencies: [])
    record = vault.opaque_records.create!(object_id:, object_type:, byte_length: 5,
      sha256: Digest::SHA256.digest(object_id), state: "DurableUncommitted",
      target_generation_id: generation_id, durable_at: Time.current,
      vault_key_epoch_id: vault.active_key_epoch_id,
      storage_key: "objects/#{object_id}",
      event_ordering_timestamp: object_type == "Event" ? Time.utc(2026, 7, 19, 12) : nil)
    dependencies.each_with_index do |dependency, ordinal|
      record.record_dependencies.create!(dependency_record: dependency, ordinal:)
    end
    record
  end

  def encoded_sha(value)
    Base64.urlsafe_encode64(Digest::SHA256.digest(value), padding: false)
  end
end
