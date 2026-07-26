module Coordination
  module Serializers
    module_function

    def vault(vault)
      generation = vault.active_generation || vault.vault_generations.find_by!(state: "Candidate")
      result = { vaultId: vault.vault_id, state: vault.state, generationId: generation.generation_id,
       generationNumber: generation.generation_number, headCursor: vault.head_cursor,
       activeKeyEpochId: vault.active_key_epoch_id }
      if generation.predecessor_generation
        result[:predecessorGenerationId] = generation.predecessor_generation.generation_id
      end
      result
    end

    def upload(upload)
      { uploadId: upload.id, objectId: upload.opaque_record.object_id, state: upload.state,
       partSizeBytes: upload.part_size, partCount: upload.part_count,
       receivedParts: upload.upload_parts.order(:part_number).pluck(:part_number),
       expiresAt: ProtocolEncoding.timestamp(upload.expires_at) }
    end


    def record(record)
      result = { objectId: record.object_id, objectType: record.object_type,
                keyEpochId: record.vault_key_epoch_id,
                byteLength: record.byte_length, sha256: ProtocolEncoding.encode_sha256(record.sha256),
                state: record.state }
      if record.object_type == "Event"
        result[:orderingTimestamp] = ProtocolEncoding.timestamp(record.event_ordering_timestamp)
        result[:dependencyObjectIds] = record.record_dependencies.order(:ordinal)
          .joins(:dependency_record).pluck("opaque_records.object_id")
      end
      result
    end
  end
end
