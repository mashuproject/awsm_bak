module Coordination
  class OpaqueUploadFinalizer
    Result = Data.define(:item, :admission, :hint_cursor)

    class << self
      def finalize!(request:, upload_handle:)
        upload = UploadCapability.authenticate!(request, upload_handle)
        return finish_promoting!(upload) if upload.state == "Promoting"

        parts = ordered_parts!(upload)
        incomplete! unless upload.accepted_offset == upload.byte_length

        installed_key = nil
        parsed = nil
        installed_key = DiskStore.install_parts(parts:) do |file, byte_length, _digest|
          invalid! unless byte_length == upload.byte_length

          policy = ServicePolicy.current
          parsed = OpaqueEnvelope.parse_io(
            file,
            byte_length:,
            compact_ceiling: policy.maximum_compact_payload_bytes,
            streamable_ceiling: policy.maximum_streamable_payload_bytes
          )
          invalid! unless parsed.storage_class == "Streamable" &&
            parsed.storage_item_id == upload.storage_item_id &&
            parsed.ciphertext_digest == upload.ciphertext_digest
        end

        result = promote!(request:, upload:, parts:, parsed:, installed_key:)
        installed_key = nil if result.admission == "stored"
        cleanup!(upload.id)
        result
      rescue SystemCallError
        raise OutcomeError.new("service_unavailable", status: :service_unavailable, retryable: true)
      ensure
        DiskStore.delete(installed_key) if installed_key
      end

      private

      def promote!(request:, upload:, parts:, parsed:, installed_key:)
        OpaqueUpload.transaction do
          locked_upload = OpaqueUpload.lock.find_by(id: upload.id)
          raise OutcomeError.new("upload_expired", status: :gone) unless locked_upload

          UploadCapability.authenticate!(request, locked_upload.id)
          return promoting_result(locked_upload) if locked_upload.state == "Promoting"
          unless part_identity(locked_upload.opaque_upload_parts.order(:part_number)) == part_identity(parts)
            raise OutcomeError.new("request_conflict", status: :conflict)
          end

          replica = locked_upload.hosted_replica.lock!
          grant = locked_upload.replica_access_grant.lock!
          unless replica.active? && grant.permits?("awsm.replica.item.write")
            raise OutcomeError.new("access_denied", status: :forbidden)
          end

          existing = replica.opaque_storage_items.find_by(storage_item_id: parsed.storage_item_id)
          admission = if existing
            unless existing.byte_length == parsed.byte_length &&
                DiskStore.same_bytes?(existing.storage_key, installed_key, byte_length: parsed.byte_length)
              raise OutcomeError.new("item_integrity_conflict", status: :conflict)
            end
            "already_present"
          else
            resulting_bytes = replica.stored_bytes + parsed.byte_length
            if replica.quota_bytes && resulting_bytes > replica.quota_bytes
              raise OutcomeError.new("quota_exceeded", status: :content_too_large)
            end
            cursor = replica.inventory_cursor + 1
            existing = replica.opaque_storage_items.create!(
              admitted_by_grant: grant,
              storage_item_id: parsed.storage_item_id,
              storage_class: parsed.storage_class,
              byte_length: parsed.byte_length,
              ciphertext_digest: parsed.ciphertext_digest,
              storage_key: installed_key,
              inventory_cursor: cursor
            )
            replica.update!(
              stored_bytes: resulting_bytes,
              inventory_cursor: cursor,
              hint_cursor: replica.hint_cursor + 1
            )
            "stored"
          end
          locked_upload.update!(state: "Promoting")
          Result.new(item: existing, admission:, hint_cursor: replica.hint_cursor)
        end
      end

      def finish_promoting!(upload)
        result = promoting_result(upload)
        cleanup!(upload.id)
        result
      end

      def promoting_result(upload)
        item = upload.hosted_replica.opaque_storage_items.find_by(storage_item_id: upload.storage_item_id)
        unless item && item.byte_length == upload.byte_length &&
            item.ciphertext_digest == upload.ciphertext_digest
          raise OutcomeError.new("service_unavailable", status: :service_unavailable, retryable: true)
        end
        OpaqueStoredItemVerifier.verify!(item)

        Result.new(
          item:,
          admission: "already_present",
          hint_cursor: upload.hosted_replica.hint_cursor
        )
      end

      def cleanup!(upload_id)
        upload = OpaqueUpload.includes(:opaque_upload_parts).find_by(id: upload_id)
        return unless upload

        upload.opaque_upload_parts.each { |part| DiskStore.delete(part.storage_key) }
        OpaqueUpload.transaction { OpaqueUpload.lock.find_by(id: upload_id)&.destroy! }
      end

      def ordered_parts!(upload)
        parts = upload.opaque_upload_parts.order(:part_number).to_a
        expected_offset = 0
        parts.each_with_index do |part, index|
          incomplete! unless part.part_number == index && part.start_offset == expected_offset

          expected_offset += part.byte_length
        end
        incomplete! unless expected_offset == upload.accepted_offset

        parts
      end

      def part_identity(parts)
        parts.map do |part|
          [ part.id, part.part_number, part.start_offset, part.byte_length, part.sha256, part.storage_key ]
        end
      end

      def incomplete!
        raise OutcomeError.new("upload_incomplete", status: :conflict, retryable: true)
      end

      def invalid!
        raise OutcomeError.new("outer_envelope_invalid", status: :unprocessable_content)
      end
    end
  end
end
