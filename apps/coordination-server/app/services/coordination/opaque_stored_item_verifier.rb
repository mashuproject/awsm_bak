module Coordination
  class OpaqueStoredItemVerifier
    class << self
      def verify!(item)
        policy = ServicePolicy.current
        parsed = DiskStore.open_file(item.storage_key) do |file|
          OpaqueEnvelope.parse_io(
            file,
            byte_length: item.byte_length,
            compact_ceiling: policy.maximum_compact_payload_bytes,
            streamable_ceiling: policy.maximum_streamable_payload_bytes
          )
        end
        return parsed if parsed.storage_item_id == item.storage_item_id &&
          parsed.storage_class == item.storage_class &&
          parsed.ciphertext_digest == item.ciphertext_digest

        unavailable!
      rescue SystemCallError, ArgumentError, OutcomeError
        unavailable!
      end

      private

      def unavailable!
        raise OutcomeError.new("service_unavailable", status: :service_unavailable, retryable: true)
      end
    end
  end
end
