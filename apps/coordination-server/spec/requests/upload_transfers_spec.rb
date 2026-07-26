require "rails_helper"
require "base64"
require "digest"

RSpec.describe "Opaque upload transfers", type: :request do
  let(:account) { create_account }
  let(:vault_id) { "01900000-0000-7000-8000-000000000020" }
  let(:generation_id) { "01900000-0000-7000-8000-000000000021" }
  let(:bytes) { "opaque-gen".b }
  let(:checksum) { Base64.urlsafe_encode64(Digest::SHA256.digest(bytes), padding: false) }
  let(:base_headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000022",
      "Authorization" => "Bearer proof"
    }
  end

  it "accepts, verifies, atomically installs, and finalizes opaque bytes" do
    upload, token, principal = create_upload_and_token
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(principal)

    put "/api/transfers/#{token}/parts/0", params: bytes, headers: {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000024",
      "Content-Type" => "application/octet-stream",
      "Content-Length" => bytes.bytesize.to_s,
      "Content-SHA256" => checksum
    }
    expect(response).to have_http_status(:no_content)

    post "/api/vaults/#{vault_id}/uploads/#{upload.id}/complete", headers: base_headers.merge(
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000025",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000026"
    )

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to include(
      "objectId" => generation_id, "state" => "DurableUncommitted", "sha256" => checksum
    )
    record = OpaqueRecord.find_by!(object_id: generation_id)
    expect(File.binread(Coordination::DiskStore.path(record.storage_key))).to eq(bytes)
  end

  it "rejects a part whose advertised checksum does not match its bytes" do
    upload, token, = create_upload_and_token

    put "/api/transfers/#{token}/parts/0", params: bytes, headers: {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000027",
      "Content-Type" => "application/octet-stream",
      "Content-Length" => bytes.bytesize.to_s,
      "Content-SHA256" => Base64.urlsafe_encode64(Digest::SHA256.digest("wrong"), padding: false)
    }

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("OBJECT_CHECKSUM_MISMATCH")
    expect(upload.upload_parts).to be_empty
  end

  private

  def create_upload_and_token
    vault = account.vault_replicas.create!(vault_id:, **vault_slot_attributes(account:, vault_id:),
      state: "Provisional", head_cursor: 0,
      provisional_expires_at: 1.day.from_now)
    principal = create_vault_device_principal(account:, vault:)
    generation = vault.vault_generations.create!(generation_id:, generation_number: 0,
      state: "Candidate")
    record = vault.opaque_records.create!(object_id: generation_id, object_type: "VaultGeneration",
      byte_length: bytes.bytesize, sha256: Digest::SHA256.digest(bytes), state: "Uploading",
      target_generation_id: generation_id, vault_key_epoch_id: vault.active_key_epoch_id)
    upload = record.create_upload!(state: "Open", part_size: bytes.bytesize, part_count: 1,
      expires_at: 1.day.from_now, last_activity_at: Time.current)
    generation.update!(generation_record: record)
    ticket = Coordination::TransferTicketIssuer.upload(account:, vault:, upload:)
    [ upload, ticket.fetch(:url).split("/")[3], principal ]
  end
end
