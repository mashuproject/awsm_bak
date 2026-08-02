require "rails_helper"

RSpec.describe "resumable Streamable admission", type: :request do
  let(:account) { create_account(username: "stream_writer") }
  let(:principal) { Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current) }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => SecureRandom.uuid,
      "Authorization" => "Bearer account-session"
    }
  end
  let(:replica) { HostedReplica.create! }
  let!(:grant) do
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: ReplicaAccessGrant::CAPABILITIES,
      grantable_capabilities: ReplicaAccessGrant::CAPABILITIES
    )
  end

  before do
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(principal)
  end

  it "prepares independent short-lived transfers without admitting an item" do
    envelope, ciphertext_digest = streamable_envelope
    item_id = storage_item_id(envelope)
    request_body = {
      storage_item_id: encode_id(item_id),
      locator: encode_id(Digest::SHA256.digest("host-local-locator")),
      byte_length: envelope.bytesize,
      ciphertext_digest: encode_id(ciphertext_digest)
    }

    post "/api/replicas/#{replica.id}/uploads", params: request_body, as: :json, headers: headers

    expect(response).to have_http_status(:created)
    first = response.parsed_body
    expect(first.keys).to contain_exactly(
      "upload_handle",
      "accepted_offset",
      "maximum_part_length",
      "transfer_capability"
    )
    expect(first).to include(
      "accepted_offset" => 0,
      "maximum_part_length" => 8_388_608
    )
    expect(first.fetch("transfer_capability")).to match(/\A[A-Za-z0-9_-]{43}\z/)

    upload = OpaqueUpload.find(first.fetch("upload_handle"))
    expect(upload).to have_attributes(
      hosted_replica: replica,
      replica_access_grant: grant,
      storage_item_id: item_id,
      locator: Digest::SHA256.digest("host-local-locator"),
      byte_length: envelope.bytesize,
      ciphertext_digest: ciphertext_digest,
      accepted_offset: 0,
      state: "Preparing"
    )
    expect(upload.transfer_capability_digest).to eq(
      Digest::SHA256.digest(first.fetch("transfer_capability"))
    )
    expect(upload.expires_at).to be_within(2.seconds).of(24.hours.from_now)
    expect(upload.transfer_capability_expires_at).to be_within(2.seconds).of(15.minutes.from_now)
    expect(replica.reload).to have_attributes(stored_bytes: 0, inventory_cursor: 0, hint_cursor: 0)
    expect(replica.opaque_storage_items).to be_empty

    post "/api/replicas/#{replica.id}/uploads", params: request_body, as: :json, headers: headers
    expect(response).to have_http_status(:created)
    expect(response.parsed_body.fetch("upload_handle")).not_to eq(first.fetch("upload_handle"))
    expect(replica.opaque_uploads.count).to eq(2)
  end

  it "appends exact-offset parts and makes an identical retry idempotent" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    first_bytes = envelope.byteslice(0, envelope.bytesize / 2)
    remaining_bytes = envelope.byteslice(first_bytes.bytesize..)

    put_upload_part(prepared:, offset: 0, bytes: first_bytes)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("accepted_offset" => first_bytes.bytesize)
    upload = OpaqueUpload.find(prepared.fetch("upload_handle"))
    part = upload.opaque_upload_parts.sole
    expect(part).to have_attributes(
      part_number: 0,
      start_offset: 0,
      byte_length: first_bytes.bytesize,
      sha256: Digest::SHA256.digest(first_bytes)
    )
    expect(Coordination::DiskStore.read_all(part.storage_key, byte_length: part.byte_length))
      .to eq(first_bytes)
    expect(replica.opaque_storage_items).to be_empty

    put_upload_part(prepared:, offset: 0, bytes: first_bytes)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("accepted_offset" => first_bytes.bytesize)
    expect(upload.opaque_upload_parts.count).to eq(1)

    conflicting = first_bytes.dup.tap { |bytes| bytes.setbyte(0, bytes.getbyte(0) ^ 1) }
    put_upload_part(prepared:, offset: 0, bytes: conflicting)
    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("request_conflict")

    put_upload_part(prepared:, offset: first_bytes.bytesize, bytes: remaining_bytes)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("accepted_offset" => envelope.bytesize)
    expect(upload.reload.opaque_upload_parts.order(:part_number).pluck(:start_offset, :byte_length))
      .to eq([ [ 0, first_bytes.bytesize ], [ first_bytes.bytesize, remaining_bytes.bytesize ] ])
    expect(replica.opaque_storage_items).to be_empty
  end

  it "atomically promotes a complete verified Streamable item and deduplicates later admission" do
    envelope, ciphertext_digest = streamable_envelope
    item_id = storage_item_id(envelope)
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    put_upload_part(prepared:, offset: 0, bytes: envelope)
    upload = OpaqueUpload.find(prepared.fetch("upload_handle"))
    part_keys = upload.opaque_upload_parts.pluck(:storage_key)
    expect(replica.reload).to have_attributes(stored_bytes: 0, inventory_cursor: 0, hint_cursor: 0)

    finalize_upload(prepared:)

    expect(response).to have_http_status(:created)
    expect(response.parsed_body).to eq(
      "storage_item_id" => encode_id(item_id),
      "byte_length" => envelope.bytesize,
      "admission" => "stored",
      "hint_cursor" => 1
    )
    item = replica.opaque_storage_items.sole
    expect(item).to have_attributes(
      admitted_by_grant: grant,
      storage_item_id: item_id,
      storage_class: "Streamable",
      byte_length: envelope.bytesize,
      ciphertext_digest: ciphertext_digest,
      inventory_cursor: 1
    )
    expect(Coordination::DiskStore.read_all(item.storage_key, byte_length: item.byte_length))
      .to eq(envelope)
    expect(OpaqueUpload.find_by(id: upload.id)).to be_nil
    expect(part_keys).to all(satisfy { |key| !Coordination::DiskStore.exists?(key) })
    expect(replica.reload).to have_attributes(
      stored_bytes: envelope.bytesize,
      inventory_cursor: 1,
      hint_cursor: 1
    )

    repeated = prepare_upload(replica:, envelope:, ciphertext_digest:)
    put_upload_part(prepared: repeated, offset: 0, bytes: envelope)
    finalize_upload(prepared: repeated)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("admission")).to eq("already_present")
    expect(replica.reload).to have_attributes(
      stored_bytes: envelope.bytesize,
      inventory_cursor: 1,
      hint_cursor: 1
    )
    expect(replica.opaque_storage_items.count).to eq(1)
  end

  it "keeps incomplete or over-quota Prepared Data invisible and rejects invalid complete bytes" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    prefix = envelope.byteslice(0, envelope.bytesize - 1)
    put_upload_part(prepared:, offset: 0, bytes: prefix)

    finalize_upload(prepared:)
    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body).to include(
      "outcome" => "upload_incomplete",
      "retryable" => true
    )
    expect(replica.opaque_storage_items).to be_empty
    expect(OpaqueUpload.find(prepared.fetch("upload_handle"))).to have_attributes(state: "Preparing")

    put_upload_part(prepared:, offset: prefix.bytesize, bytes: envelope.byteslice(-1))
    replica.update!(quota_bytes: envelope.bytesize - 1)
    finalize_upload(prepared:)
    expect(response).to have_http_status(:content_too_large)
    expect(response.parsed_body.fetch("outcome")).to eq("quota_exceeded")
    expect(replica.opaque_storage_items).to be_empty
    expect(OpaqueUpload.find(prepared.fetch("upload_handle"))).to have_attributes(state: "Preparing")

    replica.update!(quota_bytes: nil)
    malformed = envelope.dup.tap { |bytes| bytes.setbyte(-1, bytes.getbyte(-1) ^ 1) }
    invalid_prepared = prepare_upload(replica:, envelope: malformed, ciphertext_digest:)
    put_upload_part(prepared: invalid_prepared, offset: 0, bytes: malformed)
    finalize_upload(prepared: invalid_prepared)
    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("outer_envelope_invalid")
    expect(replica.opaque_storage_items).to be_empty
  end

  it "resumes cleanup after admission was committed but part deletion was interrupted" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    put_upload_part(prepared:, offset: 0, bytes: envelope)
    allow(Coordination::DiskStore).to receive(:delete).and_call_original
    allow(Coordination::DiskStore).to receive(:delete).once.and_raise(Errno::EIO)

    finalize_upload(prepared:)
    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body.fetch("outcome")).to eq("service_unavailable")
    expect(replica.reload.opaque_storage_items.count).to eq(1)
    expect(OpaqueUpload.find(prepared.fetch("upload_handle"))).to have_attributes(state: "Promoting")

    allow(Coordination::DiskStore).to receive(:delete).and_call_original
    finalize_upload(prepared:)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("admission")).to eq("already_present")
    expect(OpaqueUpload.find_by(id: prepared.fetch("upload_handle"))).to be_nil
    expect(replica.reload.opaque_storage_items.count).to eq(1)
  end

  it "keeps Promoting Prepared Data when the admitted item no longer verifies" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    put_upload_part(prepared:, offset: 0, bytes: envelope)
    upload = OpaqueUpload.find(prepared.fetch("upload_handle"))
    part_key = upload.opaque_upload_parts.sole.storage_key
    allow(Coordination::DiskStore).to receive(:delete).and_call_original
    allow(Coordination::DiskStore).to receive(:delete).once.and_raise(Errno::EIO)

    finalize_upload(prepared:)
    expect(response).to have_http_status(:service_unavailable)
    item = replica.opaque_storage_items.sole
    File.binwrite(Coordination::DiskStore.path(item.storage_key), "corrupt admitted bytes".b)
    allow(Coordination::DiskStore).to receive(:delete).and_call_original

    finalize_upload(prepared:)

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body.fetch("outcome")).to eq("service_unavailable")
    expect(OpaqueUpload.find(upload.id)).to have_attributes(state: "Promoting")
    expect(Coordination::DiskStore.exists?(part_key)).to be(true)
  end

  it "rotates an expired transfer capability through the original Account channel" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    upload = OpaqueUpload.find(prepared.fetch("upload_handle"))
    upload.update!(transfer_capability_expires_at: 1.second.ago)

    put_upload_part(prepared:, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body.fetch("outcome")).to eq("authentication_required")

    post "/api/replicas/#{replica.id}/uploads/#{upload.id}/capability",
      params: {},
      as: :json,
      headers: headers
    expect(response).to have_http_status(:ok)
    renewed = response.parsed_body
    expect(renewed).to include(
      "upload_handle" => upload.id,
      "accepted_offset" => 0,
      "maximum_part_length" => 8_388_608
    )
    expect(renewed.fetch("transfer_capability")).not_to eq(
      prepared.fetch("transfer_capability")
    )

    put_upload_part(prepared:, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:unauthorized)
    put_upload_part(prepared: renewed, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq("accepted_offset" => envelope.bytesize)
  end

  it "does not disclose or continue a transfer outside its Account, Grant, or staging lifetime" do
    envelope, ciphertext_digest = streamable_envelope
    prepared = prepare_upload(replica:, envelope:, ciphertext_digest:)
    upload = OpaqueUpload.find(prepared.fetch("upload_handle"))
    other = create_account(username: "other_stream_writer")
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: other.channel_principal,
      capabilities: %w[awsm.replica.item.write],
      grantable_capabilities: []
    )
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: other, confirmed_at: Time.current)
    )

    post "/api/replicas/#{replica.id}/uploads/#{upload.id}/capability",
      params: {},
      as: :json,
      headers: headers
    expect(response).to have_http_status(:gone)
    expect(response.parsed_body.fetch("outcome")).to eq("upload_expired")

    grant.update!(revoked_at: Time.current)
    put_upload_part(prepared:, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("access_denied")

    grant.update_column(:revoked_at, nil)
    upload.update!(expires_at: 1.second.ago)
    put_upload_part(prepared:, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:gone)
    expect(response.parsed_body.fetch("outcome")).to eq("upload_expired")
  end

  it "returns upload_expired when cleanup wins a part or finalization commit race" do
    envelope, ciphertext_digest = streamable_envelope
    part_race = prepare_upload(replica:, envelope:, ciphertext_digest:)
    part_upload = OpaqueUpload.find(part_race.fetch("upload_handle"))
    race_part_key = nil
    allow(Coordination::DiskStore).to receive(:write_part).and_wrap_original do |original, **arguments, &block|
      result = original.call(**arguments, &block)
      race_part_key = result.first
      part_upload.destroy!
      result
    end

    put_upload_part(prepared: part_race, offset: 0, bytes: envelope)
    expect(response).to have_http_status(:gone)
    expect(response.parsed_body.fetch("outcome")).to eq("upload_expired")
    expect(Coordination::DiskStore.exists?(race_part_key)).to be(false)

    allow(Coordination::DiskStore).to receive(:write_part).and_call_original
    finalize_race = prepare_upload(replica:, envelope:, ciphertext_digest:)
    put_upload_part(prepared: finalize_race, offset: 0, bytes: envelope)
    finalize_upload_row = OpaqueUpload.find(finalize_race.fetch("upload_handle"))
    assembled_key = nil
    allow(Coordination::DiskStore).to receive(:install_parts).and_wrap_original do |original, **arguments, &block|
      assembled_key = original.call(**arguments, &block)
      finalize_upload_row.opaque_upload_parts.each do |part|
        Coordination::DiskStore.delete(part.storage_key)
      end
      finalize_upload_row.destroy!
      assembled_key
    end

    finalize_upload(prepared: finalize_race)
    expect(response).to have_http_status(:gone)
    expect(response.parsed_body.fetch("outcome")).to eq("upload_expired")
    expect(Coordination::DiskStore.exists?(assembled_key)).to be(false)
    expect(replica.opaque_storage_items).to be_empty
  end

  private

  def streamable_envelope
    ciphertext = "\x09".b * 16
    payload = [ 0 ].pack("N") + "\x01".b + [ ciphertext.bytesize ].pack("N") + ciphertext
    digest = Digest::SHA256.digest(payload)
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 2,
      2 => "\x08".b * 64,
      3 => payload.bytesize,
      4 => digest,
      5 => 1_048_576
    )
    [ "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + payload, digest ]
  end

  def storage_item_id(bytes)
    Digest::SHA256.digest(
      "awsm:storage-item-id:v1\x00".b + [ 1 ].pack("N") + [ bytes.bytesize ].pack("Q>") + bytes
    )
  end

  def encode_id(value)
    Base64.urlsafe_encode64(value, padding: false)
  end

  def prepare_upload(replica:, envelope:, ciphertext_digest:)
    post "/api/replicas/#{replica.id}/uploads", params: {
      storage_item_id: encode_id(storage_item_id(envelope)),
      locator: encode_id(Digest::SHA256.digest("locator:#{storage_item_id(envelope)}")),
      byte_length: envelope.bytesize,
      ciphertext_digest: encode_id(ciphertext_digest)
    }, as: :json, headers: headers
    response.parsed_body
  end

  def put_upload_part(prepared:, offset:, bytes:)
    put "/api/uploads/#{prepared.fetch("upload_handle")}",
      params: bytes,
      headers: {
        "Awsm-Protocol-Version" => "1",
        "Awsm-Request-ID" => SecureRandom.uuid,
        "Awsm-Upload-Offset" => offset.to_s,
        "Authorization" => "Bearer #{prepared.fetch("transfer_capability")}",
        "Content-Type" => "application/octet-stream"
      }
  end


  def finalize_upload(prepared:)
    post "/api/uploads/#{prepared.fetch("upload_handle")}/finalize",
      params: {},
      as: :json,
      headers: {
        "Awsm-Protocol-Version" => "1",
        "Awsm-Request-ID" => SecureRandom.uuid,
        "Authorization" => "Bearer #{prepared.fetch("transfer_capability")}"
      }
  end
end
