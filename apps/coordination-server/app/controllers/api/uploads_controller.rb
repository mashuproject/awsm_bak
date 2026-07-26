module Api
  class UploadsController < BaseController
    def create
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CreateUpload")
      if (replay = idempotency.replay)
        return render_upload_with_ticket(Upload.find(replay.resource_id), status: :created)
      end

      vault = account_vault!
      body = request.request_parameters
      generation = eligible_generation!(vault, body.fetch("targetGenerationId"))
      validate_upload_body!(body)
      key_epoch = active_key_epoch!(vault, body.fetch("keyEpochId"))
      if (existing = OpaqueRecord.find_by(object_id: body.fetch("objectId")))
        return handle_existing!(existing, vault, body)
      end

      upload = nil
      OpaqueRecord.transaction do
        event_metadata = body["eventMetadata"]
        record = vault.opaque_records.create!(object_id: body.fetch("objectId"),
          object_type: body.fetch("objectType"), byte_length: body.fetch("byteLength"),
          sha256: Coordination::ProtocolEncoding.decode_sha256(body.fetch("sha256")),
          state: "Uploading", target_generation_id: generation.generation_id,
          vault_key_epoch: key_epoch,
          event_ordering_timestamp: event_metadata && Time.iso8601(event_metadata.fetch("orderingTimestamp")))
        dependencies_for!(vault, generation, event_metadata).each_with_index do |dependency, ordinal|
          record.record_dependencies.create!(dependency_record: dependency, ordinal:)
        end
        policy = Coordination::ServicePolicy.current
        part_size = [ policy.upload_part_size_bytes, record.byte_length ].min
        part_count = (record.byte_length.to_f / part_size).ceil
        if part_count > policy.maximum_upload_parts
          raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
        end
        upload = record.create_upload!(state: "Open", part_size:, part_count:,
          expires_at: policy.upload_staging_expiry_hours.hours.from_now, last_activity_at: Time.current)
        idempotency.persist!(resource_type: "Upload", resource_id: upload.id)
      end
      render_upload_with_ticket(upload, status: :created)
    rescue KeyError, ArgumentError, ActiveRecord::RecordInvalid
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("OBJECT_ID_CONFLICT", status: :conflict)
    end

    def show
      render json: Coordination::Serializers.upload(account_upload!)
    end

    def ticket
      upload = account_upload!
      render json: Coordination::TransferTicketIssuer.upload(account: current_account,
        vault: upload.opaque_record.vault_replica, upload:)
    end

    def complete
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CompleteUpload")
      if (replay = idempotency.replay)
        return render json: record_json(OpaqueRecord.find(replay.resource_id))
      end

      upload = account_upload!
      upload.with_lock do
        return render(json: record_json(upload.opaque_record)) if upload.state == "Completed"
        if upload.expires_at.past?
          raise Coordination::OutcomeError.new("UPLOAD_EXPIRED", status: :gone)
        end
        parts = upload.upload_parts.order(:part_number).to_a
        unless parts.map(&:part_number) == (0...upload.part_count).to_a
          raise Coordination::OutcomeError.new("OBJECT_NOT_DURABLE", status: :conflict)
        end
        record = upload.opaque_record
        upload.update!(state: "Assembling")
        key = Coordination::DiskStore.install_object(record:, parts:) do |length, sha256|
          unless length == record.byte_length
            raise Coordination::OutcomeError.new("OBJECT_LENGTH_MISMATCH", status: :unprocessable_content)
          end
          unless ActiveSupport::SecurityUtils.secure_compare(sha256, record.sha256)
            raise Coordination::OutcomeError.new("OBJECT_CHECKSUM_MISMATCH", status: :unprocessable_content)
          end
        end
        now = Time.current
        record.update!(state: "DurableUncommitted", storage_key: key, durable_at: now)
        upload.update!(state: "Completed", observed_byte_length: record.byte_length,
          observed_sha256: record.sha256, completed_at: now, last_activity_at: now)
        idempotency.persist!(resource_type: "OpaqueRecord", resource_id: record.id)
      rescue Coordination::OutcomeError
        upload.update!(state: "Open") if upload.state == "Assembling"
        raise
      end
      render json: record_json(upload.opaque_record.reload)
    end

    private

    def account_vault!
      bound_vault!
    end

    def account_upload!
      vault = account_vault!
      vault.opaque_records.joins(:upload).find_by!(uploads: { id: params[:upload_id] }).upload
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    end

    def eligible_generation!(vault, generation_id)
      generation = vault.vault_generations.find_by!(generation_id:)
      return generation if generation.state.in?([ "Active", "Candidate" ])

      raise Coordination::OutcomeError.new("VAULT_GENERATION_SUPERSEDED", status: :conflict)
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_GENERATION_SUPERSEDED", status: :conflict)
    end

    def validate_upload_body!(body)
      type = body.fetch("objectType")
      event_metadata = body["eventMetadata"]
      valid = OpaqueRecord::TYPES.include?(type) && body.fetch("byteLength").is_a?(Integer) &&
        body.fetch("byteLength").positive? && body.fetch("byteLength") <= Coordination::ServicePolicy.current.maximum_object_byte_length
      valid &&= type == "Event" ? event_metadata.present? : event_metadata.nil?
      raise KeyError unless valid

      return unless event_metadata
      ids = event_metadata.fetch("dependencyObjectIds")
      timestamp = event_metadata.fetch("orderingTimestamp")
      parsed = Time.iso8601(timestamp)
      canonical = parsed.utc.iso8601(3)
      unless ids.is_a?(Array) && ids == ids.sort && ids.uniq == ids && canonical == timestamp
        raise Coordination::OutcomeError.new("DEPENDENCY_INVALID", status: :unprocessable_content)
      end
    end

    def active_key_epoch!(vault, key_epoch_id)
      return vault.vault_key_epochs.find(key_epoch_id) if key_epoch_id == vault.active_key_epoch_id

      raise Coordination::OutcomeError.new("KEY_EPOCH_CHANGED", status: :conflict)
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("KEY_EPOCH_CHANGED", status: :conflict)
    end

    def dependencies_for!(vault, generation, event_metadata)
      return [] unless event_metadata
      ids = event_metadata.fetch("dependencyObjectIds")
      records = vault.opaque_records.where(object_id: ids,
        state: [ "Uploading", "DurableUncommitted", "Committed" ]).index_by(&:object_id)
      eligible = ids.map do |id|
        record = records[id]
        next unless record
        active_member = vault.active_generation&.generation_memberships&.exists?(opaque_record: record)
        record if record.target_generation_id == generation.generation_id || active_member
      end
      unless eligible.all? && eligible.length == ids.length
        raise Coordination::OutcomeError.new("DEPENDENCY_INVALID", status: :unprocessable_content)
      end
      eligible
    end

    def handle_existing!(record, vault, body)
      matching = record.vault_replica == vault && record.object_type == body.fetch("objectType") &&
        record.vault_key_epoch_id == body.fetch("keyEpochId") &&
        record.byte_length == body.fetch("byteLength") &&
        ActiveSupport::SecurityUtils.secure_compare(record.sha256,
          Coordination::ProtocolEncoding.decode_sha256(body.fetch("sha256")))
      unless matching
        raise Coordination::OutcomeError.new("OBJECT_ID_CONFLICT", status: :conflict)
      end
      if record.upload
        return render_upload_with_ticket(record.upload,
          status: record.state.in?([ "DurableUncommitted", "Committed" ]) ? :ok : :created)
      end
      raise Coordination::OutcomeError.new("OBJECT_ID_CONFLICT", status: :conflict)
    end

    def render_upload_with_ticket(upload, status:)
      render json: { upload: Coordination::Serializers.upload(upload),
                    ticket: Coordination::TransferTicketIssuer.upload(account: current_account,
                      vault: upload.opaque_record.vault_replica, upload:) }, status:
    end

    def record_json(record)
      result = { objectId: record.object_id, objectType: record.object_type,
                keyEpochId: record.vault_key_epoch_id,
                byteLength: record.byte_length,
                sha256: Coordination::ProtocolEncoding.encode_sha256(record.sha256), state: record.state }
      result[:orderingTimestamp] = Coordination::ProtocolEncoding.timestamp(record.event_ordering_timestamp) if record.object_type == "Event"
      result[:dependencyObjectIds] = record.record_dependencies.order(:ordinal).joins(:dependency_record).pluck("opaque_records.object_id") if record.object_type == "Event"
      result
    end
  end
end
