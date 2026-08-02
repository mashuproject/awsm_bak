module Api
  class OpaqueItemsController < BaseController
    def update
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.item.write")
      storage_item_id = Coordination::ProtocolEncoding.decode_sha256(params[:storage_item_id])
      locator = Coordination::ProtocolEncoding.decode_sha256(request.headers["Awsm-Opaque-Locator"])
      maximum = Coordination::ServicePolicy.current.maximum_compact_payload_bytes + 4_108
      bytes = request.body.read(maximum + 1).b
      if bytes.bytesize > maximum
        raise Coordination::OutcomeError.new("quota_exceeded", status: :content_too_large)
      end

      result = Coordination::OpaqueItemAdmission.admit!(
        grant:,
        claimed_storage_item_id: storage_item_id,
        locator:,
        bytes:
      )
      render json: {
        storage_item_id: Coordination::ProtocolEncoding.encode_sha256(result.item.storage_item_id),
        byte_length: result.item.byte_length,
        admission: result.admission,
        hint_cursor: result.hint_cursor
      }, status: result.admission == "stored" ? :created : :ok
    end

    def show
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.item.read")
      storage_item_id = Coordination::ProtocolEncoding.decode_sha256(params[:storage_item_id])
      item = grant.hosted_replica.opaque_storage_items.find_by(storage_item_id:)
      raise Coordination::OutcomeError.new("item_not_found", status: :not_found) unless item

      Coordination::OpaqueStoredItemVerifier.verify!(item)
      accepted_range = requested_range(item)
      offset = accepted_range ? accepted_range.begin : 0
      length = accepted_range ? accepted_range.size : item.byte_length

      response.set_header("Awsm-Storage-Item-ID", encoded_id(item.storage_item_id))
      response.set_header("Awsm-Storage-Class", item.storage_class.downcase)
      response.set_header("Awsm-Byte-Length", item.byte_length.to_s)
      response.set_header("Awsm-Ciphertext-Digest", encoded_id(item.ciphertext_digest))
      response.set_header("Content-Type", "application/octet-stream")
      response.set_header("Content-Length", length.to_s)
      if item.storage_class == "Streamable"
        response.set_header("Accept-Ranges", "bytes")
      end
      if accepted_range
        response.set_header(
          "Content-Range",
          "bytes #{accepted_range.begin}-#{accepted_range.end}/#{item.byte_length}"
        )
        self.status = :partial_content
      end
      self.response_body = Coordination::DiskStore.read_range(item.storage_key, offset:, length:)
    end

    private

    def requested_range(item)
      value = request.get_header("HTTP_RANGE")
      return if value.blank?

      match = /\Abytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)\z/.match(value)
      range_invalid! unless item.storage_class == "Streamable" && match

      first = Integer(match[1], 10)
      last = Integer(match[2], 10)
      range_invalid! unless first <= last && last < item.byte_length

      first..last
    rescue ArgumentError
      range_invalid!
    end

    def range_invalid!
      raise Coordination::OutcomeError.new("range_invalid", status: :range_not_satisfiable)
    end

    def encoded_id(value)
      Coordination::ProtocolEncoding.encode_sha256(value)
    end
  end
end
