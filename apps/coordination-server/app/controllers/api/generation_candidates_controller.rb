require "digest"
require "set"

module Api
  class GenerationCandidatesController < BaseController
    def create
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CreateGenerationCandidate")
      if (replay = idempotency.replay)
        return render_candidate(VaultGeneration.find(replay.resource_id), status: :created)
      end
      vault = active_vault!
      body = request.request_parameters
      object = body.fetch("generationObject")
      valid = body.fetch("generationNumber") == vault.active_generation.generation_number + 1 &&
        body.fetch("predecessorGenerationId") == vault.active_generation.generation_id &&
        body.fetch("headCursor") == vault.head_cursor && body.fetch("generationId") == object.fetch("objectId") &&
        object.fetch("objectType") == "VaultGeneration" &&
        object.fetch("keyEpochId") == vault.active_key_epoch_id
      raise Coordination::OutcomeError.new("VAULT_HEAD_CHANGED", status: :conflict) unless valid
      candidate = nil
      VaultGeneration.transaction do
        candidate = vault.vault_generations.create!(generation_id: body.fetch("generationId"),
          generation_number: body.fetch("generationNumber"), predecessor_generation: vault.active_generation,
          state: "Candidate", baseline_cursor: vault.head_cursor)
        record = vault.opaque_records.create!(object_id: object.fetch("objectId"),
          object_type: "VaultGeneration", byte_length: object.fetch("byteLength"),
          sha256: Coordination::ProtocolEncoding.decode_sha256(object.fetch("sha256")),
          state: "Uploading", target_generation_id: candidate.generation_id,
          vault_key_epoch_id: vault.active_key_epoch_id)
        policy = Coordination::ServicePolicy.current
        part_size = [ policy.upload_part_size_bytes, record.byte_length ].min
        record.create_upload!(state: "Open", part_size:,
          part_count: (record.byte_length.to_f / part_size).ceil,
          expires_at: policy.upload_staging_expiry_hours.hours.from_now, last_activity_at: Time.current)
        candidate.update!(generation_record: record)
        idempotency.persist!(resource_type: "VaultGeneration", resource_id: candidate.id)
      end
      render_candidate(candidate, status: :created)
    rescue KeyError, ActiveRecord::RecordInvalid
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      raise Coordination::OutcomeError.new("GENERATION_CANDIDATE_CONFLICT", status: :conflict)
    end

    def put_page
      candidate = candidate!
      raise sealed_conflict if candidate.sealed_page_count
      ids = request.request_parameters.fetch("recordIds")
      unless ids.is_a?(Array) && ids.length <= 1000 && ids == ids.sort && ids.uniq == ids
        raise reachability_invalid
      end
      page_number = Integer(params[:page_number], 10)
      records = candidate.vault_replica.opaque_records.where(object_id: ids).index_by(&:object_id)
      raise reachability_invalid unless ids.all? { |id| eligible_record?(records[id], candidate) }
      checksum = Digest::SHA256.digest(ids.map { |id| "#{id}\n" }.join)
      if (existing = candidate.generation_reachability_pages.find_by(page_number:))
        actual_ids = existing.generation_reachability_entries.order(:ordinal).joins(:opaque_record)
          .pluck("opaque_records.object_id")
        matching = actual_ids == ids && ActiveSupport::SecurityUtils.secure_compare(existing.sha256, checksum)
        raise sealed_conflict unless matching
        return head :no_content
      end
      enforce_adjacent_order!(candidate, page_number, ids)
      VaultGeneration.transaction do
        page = candidate.generation_reachability_pages.create!(page_number:, entry_count: ids.length,
          sha256: checksum, accepted_at: Time.current)
        ids.each_with_index do |id, ordinal|
          page.generation_reachability_entries.create!(vault_generation: candidate,
            opaque_record: records.fetch(id), ordinal:)
        end
      end
      head :no_content
    rescue KeyError, ArgumentError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      raise sealed_conflict
    end

    def seal
      candidate = candidate!
      body = request.request_parameters
      pages = candidate.generation_reachability_pages.order(:page_number).to_a
      page_count = body.fetch("pageCount")
      record_count = body.fetch("recordCount")
      unless pages.map(&:page_number) == (0...page_count).to_a && pages.sum(&:entry_count) == record_count
        raise reachability_invalid
      end
      records = pages.flat_map { |page| page.generation_reachability_entries.order(:ordinal).map(&:opaque_record) }
      advertised = Coordination::ProtocolEncoding.decode_sha256(body.fetch("sha256"))
      actual = Digest::SHA256.digest(records.map { |record| "#{record.object_id}\n" }.join)
      unless ActiveSupport::SecurityUtils.secure_compare(actual, advertised) &&
          candidate.generation_record.state == "DurableUncommitted"
        raise reachability_invalid
      end
      retained_ids = records.map(&:id).to_set
      events_valid = records.select { |record| record.object_type == "Event" }.all? do |event|
        event.record_dependencies.all? { |dependency| retained_ids.include?(dependency.dependency_record_id) }
      end
      raise reachability_invalid unless events_valid
      candidate.update!(sealed_page_count: page_count, sealed_record_count: record_count,
        reachability_sha256: advertised)
      render_candidate(candidate, status: :ok)
    rescue KeyError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    def activate
      candidate = candidate!
      body = request.request_parameters
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "ActivateGenerationCandidate")
      if (replay = idempotency.replay)
        return render json: Coordination::Serializers.vault(VaultReplica.find(replay.resource_id))
      end
      vault = candidate.vault_replica
      VaultReplica.transaction do
        vault.lock!
        predecessor = vault.active_generation
        fence_matches = predecessor == candidate.predecessor_generation &&
          body.fetch("predecessorGenerationId") == predecessor.generation_id &&
          body.fetch("predecessorGenerationNumber") == predecessor.generation_number
        raise Coordination::OutcomeError.new("VAULT_GENERATION_SUPERSEDED", status: :conflict) unless fence_matches
        unless body.fetch("headCursor") == vault.head_cursor && candidate.baseline_cursor == vault.head_cursor
          raise Coordination::OutcomeError.new("VAULT_HEAD_CHANGED", status: :conflict)
        end
        raise reachability_invalid unless candidate.sealed_page_count && candidate.generation_record.state == "DurableUncommitted"
        records = candidate.generation_reachability_entries.includes(:opaque_record).map(&:opaque_record)
        records << candidate.generation_record
        records.uniq.each do |record|
          record.update!(state: "Committed", committed_at: record.committed_at || Time.current)
          candidate.generation_memberships.find_or_create_by!(opaque_record: record)
        end
        now = Time.current
        predecessor.update!(state: "Superseded", superseded_at: now,
          purge_after: Coordination::ServicePolicy.current.recovery_retention_days.days.from_now)
        candidate.update!(state: "Active", activated_at: now)
        cursor = vault.head_cursor + 1
        vault.update!(active_generation: candidate, active_generation_number: candidate.generation_number,
          head_cursor: cursor)
        DeliveryChange.create!(vault_replica: vault, vault_generation: candidate, cursor:,
          kind: "GenerationActivated", accepted_at: now)
        idempotency.persist!(resource_type: "VaultReplica", resource_id: vault.id)
      end
      Coordination::VaultNotifier.broadcast(vault.reload)
      render json: Coordination::Serializers.vault(vault)
    rescue KeyError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    def destroy
      candidate = candidate!
      raise sealed_conflict unless candidate.state == "Candidate"
      VaultGeneration.transaction do
        candidate.generation_reachability_pages.destroy_all
        candidate.update!(generation_record: nil)
        candidate.vault_replica.opaque_records.where(target_generation_id: candidate.generation_id)
          .find_each do |record|
          if record.upload
            TransferTicket.where(upload: record.upload).delete_all
            record.upload.destroy!
          end
          record.record_dependencies.destroy_all
          record.destroy!
        end
        candidate.destroy!
      end
      head :no_content
    end

    private

    def active_vault!
      vault = bound_vault!
      return vault if vault.state == "Active" && vault.active_generation
      raise Coordination::OutcomeError.new("VAULT_NOT_READY", status: :conflict)
    end

    def candidate!
      active_vault!.vault_generations.find_by!(generation_id: params[:generation_id], state: "Candidate")
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("GENERATION_CANDIDATE_CONFLICT", status: :conflict)
    end

    def eligible_record?(record, candidate)
      record && record.state != "Purged" &&
        (record.target_generation_id == candidate.generation_id ||
         candidate.vault_replica.active_generation.generation_memberships.exists?(opaque_record: record))
    end

    def enforce_adjacent_order!(candidate, page_number, ids)
      previous = candidate.generation_reachability_pages.find_by(page_number: page_number - 1)
      following = candidate.generation_reachability_pages.find_by(page_number: page_number + 1)
      previous_last = previous&.generation_reachability_entries&.order(:ordinal)&.last&.opaque_record&.object_id
      following_first = following&.generation_reachability_entries&.order(:ordinal)&.first&.opaque_record&.object_id
      raise reachability_invalid if previous_last && ids.first && previous_last >= ids.first
      raise reachability_invalid if following_first && ids.last && ids.last >= following_first
    end

    def render_candidate(candidate, status:)
      payload = { generationId: candidate.generation_id, generationNumber: candidate.generation_number,
                 predecessorGenerationId: candidate.predecessor_generation.generation_id,
                 baselineCursor: candidate.baseline_cursor,
                 state: candidate.sealed_page_count ? "Sealed" : "Candidate" }
      if candidate.generation_record.upload
        payload[:upload] = Coordination::Serializers.upload(candidate.generation_record.upload)
        payload[:ticket] = Coordination::TransferTicketIssuer.upload(account: current_account,
          vault: candidate.vault_replica, upload: candidate.generation_record.upload)
      end
      render json: payload, status:
    end

    def reachability_invalid
      Coordination::OutcomeError.new("GENERATION_REACHABILITY_INVALID", status: :unprocessable_content)
    end

    def sealed_conflict
      Coordination::OutcomeError.new("GENERATION_CANDIDATE_CONFLICT", status: :conflict)
    end
  end
end
