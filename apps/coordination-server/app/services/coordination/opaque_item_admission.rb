module Coordination
  class OpaqueItemAdmission
    Result = Data.define(:item, :admission, :hint_cursor)

    class << self
      def admit!(grant:, claimed_storage_item_id:, bytes:)
        parsed = OpaqueEnvelope.parse(
          bytes,
          compact_ceiling: ServicePolicy.current.maximum_compact_payload_bytes
        )
        unless parsed.storage_class == "Compact" && parsed.storage_item_id == claimed_storage_item_id
          raise OutcomeError.new("outer_envelope_invalid", status: :unprocessable_content)
        end

        installed_key = nil
        result = HostedReplica.transaction do
          replica = grant.hosted_replica.lock!
          grant.lock!
          unless replica.active? && grant.permits?("awsm.replica.item.write")
            raise OutcomeError.new("access_denied", status: :forbidden)
          end

          existing = replica.opaque_storage_items.find_by(storage_item_id: parsed.storage_item_id)
          if existing
            existing_bytes = DiskStore.read_all(existing.storage_key, byte_length: existing.byte_length)
            unless existing_bytes == bytes
              raise OutcomeError.new("item_integrity_conflict", status: :conflict)
            end

            next Result.new(item: existing, admission: "already_present", hint_cursor: replica.hint_cursor)
          end

          resulting_bytes = replica.stored_bytes + parsed.byte_length
          if replica.quota_bytes && resulting_bytes > replica.quota_bytes
            raise OutcomeError.new("quota_exceeded", status: :content_too_large)
          end

          installed_key = DiskStore.install_bytes(bytes)
          cursor = replica.inventory_cursor + 1
          item = replica.opaque_storage_items.create!(
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
          Result.new(item:, admission: "stored", hint_cursor: replica.hint_cursor)
        end
        installed_key = nil
        result
      rescue SystemCallError
        raise OutcomeError.new("service_unavailable", status: :service_unavailable, retryable: true)
      ensure
        DiskStore.delete(installed_key) if installed_key
      end
    end
  end
end
