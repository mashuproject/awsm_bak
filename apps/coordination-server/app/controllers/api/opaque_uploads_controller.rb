require "digest"
require "securerandom"

module Api
  class OpaqueUploadsController < BaseController
    def create
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.item.write")
      storage_item_id = Coordination::ProtocolEncoding.decode_sha256(params[:storage_item_id])
      ciphertext_digest = Coordination::ProtocolEncoding.decode_sha256(params[:ciphertext_digest])
      byte_length = params[:byte_length]
      policy = Coordination::ServicePolicy.current
      unless byte_length.is_a?(Integer) && byte_length.positive? &&
          byte_length <= policy.maximum_streamable_payload_bytes + 4_108
        raise Coordination::OutcomeError.new("quota_exceeded", status: :content_too_large)
      end

      transfer_capability = SecureRandom.urlsafe_base64(32, false)
      now = Time.current
      upload = OpaqueUpload.transaction do
        replica = grant.hosted_replica.lock!
        grant.lock!
        unless replica.active? && grant.permits?("awsm.replica.item.write")
          raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
        end
        if replica.quota_bytes && replica.stored_bytes + byte_length > replica.quota_bytes
          raise Coordination::OutcomeError.new("quota_exceeded", status: :content_too_large)
        end

        replica.opaque_uploads.create!(
          replica_access_grant: grant,
          storage_item_id:,
          byte_length:,
          ciphertext_digest:,
          transfer_capability_digest: Digest::SHA256.digest(transfer_capability),
          transfer_capability_expires_at: now + policy.upload_capability_lifetime_seconds,
          expires_at: now + policy.upload_staging_expiry_hours.hours
        )
      end

      render json: {
        upload_handle: upload.id,
        accepted_offset: upload.accepted_offset,
        maximum_part_length: policy.maximum_upload_part_bytes,
        transfer_capability:
      }, status: :created
    end

    def capability
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.item.write")
      policy = Coordination::ServicePolicy.current
      transfer_capability = SecureRandom.urlsafe_base64(32, false)
      now = Time.current
      upload = OpaqueUpload.transaction do
        locked_upload = grant.hosted_replica.opaque_uploads.lock.find_by(
          id: params[:upload_handle]
        )
        unless locked_upload && locked_upload.expires_at > now &&
            locked_upload.replica_access_grant.channel_principal_id == current_principal.channel_principal.id
          raise Coordination::OutcomeError.new("upload_expired", status: :gone)
        end

        grant.lock!
        unless grant.permits?("awsm.replica.item.write")
          raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
        end
        locked_upload.update!(
          replica_access_grant: grant,
          transfer_capability_digest: Digest::SHA256.digest(transfer_capability),
          transfer_capability_expires_at: now + policy.upload_capability_lifetime_seconds
        )
        locked_upload
      end

      render json: {
        upload_handle: upload.id,
        accepted_offset: upload.accepted_offset,
        maximum_part_length: policy.maximum_upload_part_bytes,
        transfer_capability:
      }
    end
  end
end
