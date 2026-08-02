require "rails_helper"

RSpec.describe "opaque Hosted Replica items", type: :request do
  let(:account) { create_account(username: "opaque_writer") }
  let(:principal) do
    Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current)
  end
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => SecureRandom.uuid,
      "Authorization" => "Bearer opaque-test-session"
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

  it "admits one exact Compact item idempotently and reads the same opaque bytes" do
    envelope = compact_envelope(payload: "\x07".b * 16)
    item_id = storage_item_id(envelope)

    put_item(replica:, item_id:, bytes: envelope)

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
      storage_class: "Compact",
      byte_length: envelope.bytesize,
      inventory_cursor: 1
    )

    put_item(replica:, item_id:, bytes: envelope)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("admission")).to eq("already_present")
    expect(replica.reload).to have_attributes(
      stored_bytes: envelope.bytesize,
      inventory_cursor: 1,
      hint_cursor: 1
    )

    get "/api/replicas/#{replica.id}/items/#{encode_id(item_id)}", headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.media_type).to eq("application/octet-stream")
    expect(response.body.b).to eq(envelope)
    expect(response.headers).to include(
      "Awsm-Storage-Item-ID" => encode_id(item_id),
      "Awsm-Storage-Class" => "compact",
      "Awsm-Byte-Length" => envelope.bytesize.to_s,
      "Awsm-Ciphertext-Digest" => encode_id(Digest::SHA256.digest("\x07".b * 16))
    )
  end

  it "paginates a fixed snapshot and excludes items admitted afterward" do
    first = compact_envelope(payload: "\x01".b * 16)
    second = compact_envelope(payload: "\x02".b * 16)
    later = compact_envelope(payload: "\x03".b * 16)
    [ first, second ].each { |bytes| put_item(replica:, item_id: storage_item_id(bytes), bytes:) }

    get "/api/replicas/#{replica.id}/inventory", params: { limit: 1 }, headers: headers

    expect(response).to have_http_status(:ok)
    first_page = response.parsed_body
    expect(first_page.fetch("snapshot_cursor")).to eq(2)
    expect(first_page.fetch("items").length).to eq(1)
    expect(first_page.fetch("next_position")).to be_present

    put_item(replica:, item_id: storage_item_id(later), bytes: later)
    get "/api/replicas/#{replica.id}/inventory", params: {
      limit: 1,
      snapshot_cursor: first_page.fetch("snapshot_cursor"),
      position: first_page.fetch("next_position")
    }, headers: headers

    expect(response).to have_http_status(:ok)
    second_page = response.parsed_body
    expect(second_page.fetch("snapshot_cursor")).to eq(2)
    expect(second_page.fetch("items").length).to eq(1)
    expect(second_page.fetch("next_position")).to be_nil
    returned_ids = first_page.fetch("items").pluck("storage_item_id") +
      second_page.fetch("items").pluck("storage_item_id")
    expect(returned_ids).to contain_exactly(encode_id(storage_item_id(first)), encode_id(storage_item_id(second)))

    get "/api/replicas/#{replica.id}/inventory", params: {
      snapshot_cursor: first_page.fetch("snapshot_cursor"),
      position: encode_id(storage_item_id(later))
    }, headers: headers
    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body.fetch("outcome")).to eq("cursor_invalid")
  end

  it "enforces quota, capability, strict envelope validation, and cross-Principal isolation" do
    envelope = compact_envelope
    item_id = storage_item_id(envelope)
    replica.update!(quota_bytes: envelope.bytesize - 1)

    put_item(replica:, item_id:, bytes: envelope)
    expect(response).to have_http_status(:content_too_large)
    expect(response.parsed_body.fetch("outcome")).to eq("quota_exceeded")
    expect(replica.opaque_storage_items).to be_empty

    replica.update!(quota_bytes: nil)
    malformed = envelope.dup.tap { |bytes| bytes.setbyte(-1, bytes.getbyte(-1) ^ 1) }
    put_item(replica:, item_id:, bytes: malformed)
    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("outer_envelope_invalid")

    reader = create_account(username: "inventory_only")
    ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: reader.channel_principal,
      capabilities: %w[awsm.replica.inventory.read],
      grantable_capabilities: []
    )
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: reader, confirmed_at: Time.current)
    )
    put_item(replica:, item_id:, bytes: envelope)
    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("access_denied")

    stranger = create_account(username: "opaque_stranger")
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account: stranger, confirmed_at: Time.current)
    )
    get "/api/replicas/#{replica.id}/inventory", headers: headers
    expect(response).to have_http_status(:not_found)
    expect(response.parsed_body.fetch("outcome")).to eq("replica_not_found")
  end

  it "serves exact byte ranges only for Streamable items" do
    streamable = streamable_envelope(
      payload: stream_frame(index: 0, final: true, ciphertext: "\x04".b * 16)
    )
    streamable_item = store_item(replica:, bytes: streamable)
    start_offset = streamable.bytesize - 12
    end_offset = streamable.bytesize - 5

    get "/api/replicas/#{replica.id}/items/#{encode_id(streamable_item.storage_item_id)}",
      headers: headers.merge("Range" => "bytes=#{start_offset}-#{end_offset}")

    expect(response).to have_http_status(:partial_content)
    expect(response.body.b).to eq(streamable.byteslice(start_offset..end_offset))
    expect(response.headers).to include(
      "Accept-Ranges" => "bytes",
      "Content-Range" => "bytes #{start_offset}-#{end_offset}/#{streamable.bytesize}",
      "Content-Length" => (end_offset - start_offset + 1).to_s
    )

    compact = compact_envelope
    compact_item = store_item(replica:, bytes: compact)
    get "/api/replicas/#{replica.id}/items/#{encode_id(compact_item.storage_item_id)}",
      headers: headers.merge("Range" => "bytes=0-15")
    expect(response).to have_http_status(:range_not_satisfiable)
    expect(response.parsed_body.fetch("outcome")).to eq("range_invalid")

    get "/api/replicas/#{replica.id}/items/#{encode_id(streamable_item.storage_item_id)}",
      headers: headers.merge("Range" => "bytes=0-1,4-5")
    expect(response).to have_http_status(:range_not_satisfiable)
    expect(response.parsed_body.fetch("outcome")).to eq("range_invalid")
  end

  it "fails safely when stored opaque bytes no longer match admitted metadata" do
    envelope = compact_envelope
    item = store_item(replica:, bytes: envelope)
    path = Coordination::DiskStore.path(item.storage_key)
    File.open(path, "r+b") do |file|
      file.seek(-1, IO::SEEK_END)
      file.write("\xff".b)
      file.flush
      file.fsync
    end

    get "/api/replicas/#{replica.id}/items/#{encode_id(item.storage_item_id)}", headers: headers

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body).to include(
      "outcome" => "service_unavailable",
      "retryable" => true
    )
  end

  private

  def compact_envelope(payload: "\x00".b * 16)
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 1,
      2 => (0...64).to_a.pack("C*"),
      3 => payload.bytesize,
      4 => Digest::SHA256.digest(payload),
      5 => 0
    )
    "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + payload
  end

  def stream_frame(index:, final:, ciphertext:)
    [ index ].pack("N") + (final ? "\x01" : "\x00").b +
      [ ciphertext.bytesize ].pack("N") + ciphertext
  end

  def streamable_envelope(payload:)
    header = Coordination::CanonicalCbor.encode(
      0 => 1,
      1 => 2,
      2 => "\x03".b * 64,
      3 => payload.bytesize,
      4 => Digest::SHA256.digest(payload),
      5 => 1_048_576
    )
    "AWSMSE\x01\x00".b + [ header.bytesize ].pack("N") + header + payload
  end

  def store_item(replica:, bytes:)
    parsed = Coordination::OpaqueEnvelope.parse(bytes)
    storage_key = Coordination::DiskStore.install_bytes(bytes)
    replica.with_lock do
      cursor = replica.inventory_cursor + 1
      item = replica.opaque_storage_items.create!(
        admitted_by_grant: grant,
        storage_item_id: parsed.storage_item_id,
        storage_class: parsed.storage_class,
        byte_length: parsed.byte_length,
        ciphertext_digest: parsed.ciphertext_digest,
        storage_key:,
        inventory_cursor: cursor
      )
      replica.update!(
        stored_bytes: replica.stored_bytes + parsed.byte_length,
        inventory_cursor: cursor,
        hint_cursor: replica.hint_cursor + 1
      )
      item
    end
  end

  def storage_item_id(bytes)
    Digest::SHA256.digest(
      "awsm:storage-item-id:v1\x00".b + [ 1 ].pack("N") + [ bytes.bytesize ].pack("Q>") + bytes
    )
  end

  def encode_id(value)
    Base64.urlsafe_encode64(value, padding: false)
  end

  def put_item(replica:, item_id:, bytes:)
    put "/api/replicas/#{replica.id}/items/#{encode_id(item_id)}",
      params: bytes,
      headers: headers.merge("Content-Type" => "application/octet-stream")
  end
end
