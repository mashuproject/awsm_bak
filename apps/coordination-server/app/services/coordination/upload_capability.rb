require "digest"

module Coordination
  class UploadCapability
    class << self
      def authenticate!(request, upload_handle, at: Time.current)
        upload = OpaqueUpload.includes(:hosted_replica, :replica_access_grant).find_by(id: upload_handle)
        upload_expired! unless upload && upload.expires_at > at

        token = bearer_credential(request)
        unless token&.match?(/\A[A-Za-z0-9_-]{43}\z/) &&
            upload.transfer_capability_expires_at > at &&
            secure_equal?(upload.transfer_capability_digest, Digest::SHA256.digest(token))
          raise OutcomeError.new("authentication_required", status: :unauthorized)
        end
        unless upload.hosted_replica.active? &&
            upload.replica_access_grant.permits?("awsm.replica.item.write")
          raise OutcomeError.new("access_denied", status: :forbidden)
        end

        upload
      rescue ActiveRecord::StatementInvalid
        upload_expired!
      end

      private

      def bearer_credential(request)
        scheme, value = request.authorization.to_s.split(" ", 2)
        value if scheme == "Bearer" && value.present?
      end

      def secure_equal?(left, right)
        left.bytesize == right.bytesize && ActiveSupport::SecurityUtils.secure_compare(left, right)
      end

      def upload_expired!
        raise OutcomeError.new("upload_expired", status: :gone)
      end
    end
  end
end
