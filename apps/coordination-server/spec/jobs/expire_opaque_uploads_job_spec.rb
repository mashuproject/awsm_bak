require "rails_helper"

RSpec.describe ExpireOpaqueUploadsJob do
  def create_upload(grant:, expires_at:, bytes: nil)
    token = SecureRandom.urlsafe_base64(32, false)
    upload = OpaqueUpload.create!(
      hosted_replica: grant.hosted_replica,
      replica_access_grant: grant,
      storage_item_id: Digest::SHA256.digest("upload-item:#{SecureRandom.uuid}"),
      locator: Digest::SHA256.digest("locator:#{SecureRandom.uuid}"),
      byte_length: bytes&.bytesize || 100,
      ciphertext_digest: Digest::SHA256.digest("ciphertext:#{SecureRandom.uuid}"),
      transfer_capability_digest: Digest::SHA256.digest(token),
      transfer_capability_expires_at: expires_at,
      expires_at:
    )
    return upload unless bytes

    storage_key, byte_length, sha256 = Coordination::DiskStore.write_part(
      upload_id: upload.id,
      io: StringIO.new(bytes)
    ) { }
    upload.opaque_upload_parts.create!(
      part_number: 0,
      start_offset: 0,
      byte_length:,
      sha256:,
      storage_key:
    )
    upload.update!(accepted_offset: byte_length)
    upload
  end

  it "removes only expired Prepared Data and its physical parts" do
    now = Time.zone.parse("2026-08-02 12:00:00")
    account = create_account(username: "upload_cleanup")
    replica = HostedReplica.create!
    grant = ReplicaAccessGrant.create!(
      hosted_replica: replica,
      channel_principal: account.channel_principal,
      capabilities: %w[awsm.replica.item.write],
      grantable_capabilities: []
    )
    expired = create_upload(grant:, expires_at: now - 1.second, bytes: "expired bytes".b)
    current = create_upload(grant:, expires_at: now + 1.hour, bytes: "current bytes".b)
    expired_key = expired.opaque_upload_parts.sole.storage_key
    current_key = current.opaque_upload_parts.sole.storage_key

    described_class.perform_now(at: now)

    expect(OpaqueUpload.find_by(id: expired.id)).to be_nil
    expect(Coordination::DiskStore.exists?(expired_key)).to be(false)
    expect(OpaqueUpload.find_by(id: current.id)).to eq(current)
    expect(Coordination::DiskStore.exists?(current_key)).to be(true)
  end

  it "is configured as an hourly production recurring job" do
    recurring = YAML.safe_load(
      Rails.root.join("config/recurring.yml").read,
      permitted_classes: [ Symbol ]
    )

    expect(recurring.dig("production", "expire_opaque_uploads")).to eq(
      "class" => "ExpireOpaqueUploadsJob",
      "queue" => "default",
      "schedule" => "every hour at minute 5"
    )
  end
end
