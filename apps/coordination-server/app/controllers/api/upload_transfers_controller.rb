module Api
  class UploadTransfersController < ProtocolController
    def update
      upload = Coordination::UploadCapability.authenticate!(request, params[:upload_handle])
      offset = upload_offset
      policy = Coordination::ServicePolicy.current
      installed_key = nil
      storage_key, byte_length, sha256 = Coordination::DiskStore.write_part(
        upload_id: upload.id,
        io: request.body
      ) do |length, _digest|
        if length.zero? || length > policy.maximum_upload_part_bytes
          raise Coordination::OutcomeError.new("quota_exceeded", status: :content_too_large)
        end
      end
      installed_key = storage_key

      accepted_offset = OpaqueUpload.transaction do
        locked_upload = OpaqueUpload.lock.find_by(id: upload.id)
        unless locked_upload
          raise Coordination::OutcomeError.new("upload_expired", status: :gone)
        end
        Coordination::UploadCapability.authenticate!(request, locked_upload.id)
        existing = locked_upload.opaque_upload_parts.find_by(start_offset: offset)
        if existing
          unless existing.byte_length == byte_length && existing.sha256 == sha256
            raise Coordination::OutcomeError.new("request_conflict", status: :conflict)
          end
          next locked_upload.accepted_offset
        end
        unless offset == locked_upload.accepted_offset &&
            byte_length <= locked_upload.byte_length - locked_upload.accepted_offset &&
            locked_upload.opaque_upload_parts.count < policy.maximum_upload_parts
          raise Coordination::OutcomeError.new("request_conflict", status: :conflict)
        end

        part_number = locked_upload.opaque_upload_parts.count
        locked_upload.opaque_upload_parts.create!(
          part_number:,
          start_offset: offset,
          byte_length:,
          sha256:,
          storage_key:
        )
        locked_upload.update!(accepted_offset: locked_upload.accepted_offset + byte_length)
        installed_key = nil
        locked_upload.accepted_offset
      end
      render json: { accepted_offset: }
    rescue SystemCallError
      raise Coordination::OutcomeError.new(
        "service_unavailable",
        status: :service_unavailable,
        retryable: true
      )
    ensure
      Coordination::DiskStore.delete(installed_key) if installed_key
    end

    def finalize
      result = Coordination::OpaqueUploadFinalizer.finalize!(
        request:,
        upload_handle: params[:upload_handle]
      )
      render json: {
        storage_item_id: Coordination::ProtocolEncoding.encode_sha256(result.item.storage_item_id),
        byte_length: result.item.byte_length,
        admission: result.admission,
        hint_cursor: result.hint_cursor
      }, status: result.admission == "stored" ? :created : :ok
    end

    private

    def upload_offset
      value = request.get_header("HTTP_AWSM_UPLOAD_OFFSET")
      raise ArgumentError unless value&.match?(/\A(?:0|[1-9][0-9]*)\z/)

      Integer(value, 10)
    rescue ArgumentError
      raise Coordination::OutcomeError.new("protocol_invalid", status: :bad_request)
    end
  end
end
