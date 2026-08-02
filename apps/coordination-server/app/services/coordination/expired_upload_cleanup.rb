module Coordination
  class ExpiredUploadCleanup
    class << self
      def perform!(upload_id, at: Time.current)
        upload = OpaqueUpload.includes(:opaque_upload_parts).find_by(id: upload_id)
        return unless upload && upload.expires_at <= at

        upload.opaque_upload_parts.each { |part| DiskStore.delete(part.storage_key) }
        OpaqueUpload.transaction do
          locked_upload = OpaqueUpload.lock.find_by(id: upload_id)
          locked_upload.destroy! if locked_upload && locked_upload.expires_at <= at
        end
      end
    end
  end
end
