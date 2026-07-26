require "rails_helper"
require "base64"
require "digest"

RSpec.describe "Successor Generation and recovery", type: :request do
  let(:account) { create_account }
  let(:vault_id) { "01900000-0000-7000-8000-000000000050" }
  let(:predecessor_id) { "01900000-0000-7000-8000-000000000051" }
  let(:successor_id) { "01900000-0000-7000-8000-000000000052" }
  let(:retained_id) { "01900000-0000-7000-8000-000000000053" }
  let(:headers) do
    { "Awsm-Protocol-Version" => "1",
     "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000054",
     "Authorization" => "Bearer proof", "Content-Type" => "application/json" }
  end
  let!(:vault) { active_vault }

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      create_vault_device_principal(account:, vault:)
    )
  end

  it "seals explicit reachability and atomically activates a fenced successor" do
    post "/api/vaults/#{vault_id}/generation-candidates", params: {
      generationId: successor_id, generationNumber: 1,
      predecessorGenerationId: predecessor_id, headCursor: 2,
      generationObject: { objectId: successor_id, objectType: "VaultGeneration",
                         keyEpochId: vault.active_key_epoch_id,
                         byteLength: 8, sha256: encoded_sha("next-gen") }
    }.to_json, headers: headers.merge(
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000055"
    )
    expect(response).to have_http_status(:created)
    expect(response.parsed_body).to include("generationId" => successor_id, "state" => "Candidate")
    candidate = VaultGeneration.find_by!(generation_id: successor_id)
    candidate.generation_record.update!(state: "DurableUncommitted", durable_at: Time.current,
      storage_key: "objects/#{successor_id}")

    put "/api/vaults/#{vault_id}/generation-candidates/#{successor_id}/retained-pages/0",
      params: { recordIds: [ retained_id ] }.to_json,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000056")
    expect(response).to have_http_status(:no_content)

    reachability = encoded_sha("#{retained_id}\n")
    post "/api/vaults/#{vault_id}/generation-candidates/#{successor_id}/seal",
      params: { pageCount: 1, recordCount: 1, sha256: reachability }.to_json,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000057")
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("state")).to eq("Sealed")

    post "/api/vaults/#{vault_id}/generation-candidates/#{successor_id}/activate",
      params: { predecessorGenerationId: predecessor_id, predecessorGenerationNumber: 0,
               headCursor: 2 }.to_json,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000058")

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include("generationId" => successor_id,
                                            "generationNumber" => 1, "headCursor" => 3)
    expect(vault.reload.active_generation).to eq(candidate)
    expect(candidate.opaque_records.pluck(:object_id).sort).to eq([ successor_id, retained_id ].sort)
    predecessor = VaultGeneration.find_by!(generation_id: predecessor_id)
    expect(predecessor.state).to eq("Superseded")
    expect(predecessor.purge_after).to be_within(2.seconds).of(90.days.from_now)

    get "/api/vaults/#{vault_id}/recoveries", headers: headers.except("Content-Type")
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("recoveries").first).to include(
      "generationId" => predecessor_id, "state" => "Superseded", "recordCount" => 1
    )
  end

  it "rejects activation when the observed head cursor became stale" do
    candidate = candidate_with_durable_generation
    candidate.update!(sealed_page_count: 0, sealed_record_count: 0,
      reachability_sha256: Digest::SHA256.digest(""))

    post "/api/vaults/#{vault_id}/generation-candidates/#{successor_id}/activate",
      params: { predecessorGenerationId: predecessor_id, predecessorGenerationNumber: 0,
               headCursor: 1 }.to_json,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000059")

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("VAULT_HEAD_CHANGED")
    expect(vault.reload.active_generation.generation_id).to eq(predecessor_id)
  end

  private

  def active_vault
    replica = account.vault_replicas.create!(vault_id:, **vault_slot_attributes(account:, vault_id:),
      state: "Active", head_cursor: 2,
      active_generation_number: 0)
    create_vault_device_principal(account:, vault: replica)
    generation = replica.vault_generations.create!(generation_id: predecessor_id,
      generation_number: 0, state: "Active", activated_at: Time.current)
    replica.update!(active_generation: generation)
    retained = replica.opaque_records.create!(object_id: retained_id, object_type: "Artifact",
      byte_length: 4, sha256: Digest::SHA256.digest("data"), state: "Committed",
      target_generation_id: predecessor_id, durable_at: Time.current, committed_at: Time.current,
      storage_key: "objects/#{retained_id}",
      vault_key_epoch_id: replica.active_key_epoch_id)
    generation.generation_memberships.create!(opaque_record: retained)
    replica
  end

  def candidate_with_durable_generation
    candidate = vault.vault_generations.create!(generation_id: successor_id, generation_number: 1,
      predecessor_generation: vault.active_generation, state: "Candidate", baseline_cursor: 2)
    record = vault.opaque_records.create!(object_id: successor_id, object_type: "VaultGeneration",
      byte_length: 8, sha256: Digest::SHA256.digest("next-gen"), state: "DurableUncommitted",
      target_generation_id: successor_id, durable_at: Time.current,
      storage_key: "objects/#{successor_id}",
      vault_key_epoch_id: vault.active_key_epoch_id)
    candidate.update!(generation_record: record)
    candidate
  end

  def encoded_sha(value)
    Base64.urlsafe_encode64(Digest::SHA256.digest(value), padding: false)
  end
end
