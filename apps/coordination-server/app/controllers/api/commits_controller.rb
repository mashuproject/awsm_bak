require "digest"

module Api
  class CommitsController < BaseController
    def create
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CommitEventClosure")
      if (replay = idempotency.replay)
        return render json: commit_json(EventCommit.find(replay.resource_id))
      end

      vault = account_vault!
      body = request.request_parameters
      dependency_ids = body.fetch("dependencyObjectIds")
      validate_dependencies!(dependency_ids)
      event_commit = nil
      retained_generation = nil
      retained_cursor = nil
      VaultReplica.transaction do
        vault.lock!
        generation = vault.active_generation
        unless vault.state.in?(%w[Active Provisional]) &&
            generation&.generation_id == body.fetch("generationId") &&
            generation.generation_number == body.fetch("generationNumber")
          raise Coordination::OutcomeError.new("VAULT_GENERATION_SUPERSEDED", status: :conflict)
        end
        event = vault.opaque_records.find_by!(object_id: body.fetch("eventObjectId"), object_type: "Event")
        request_sha256 = Digest::SHA256.digest(request.raw_post)
        if (existing = EventCommit.find_by(event_record: event))
          bound_ids = event.record_dependencies.order(:ordinal).joins(:dependency_record).pluck("opaque_records.object_id")
          closure = [ event ] + event.record_dependencies.order(:ordinal).map(&:dependency_record)
          active_closure = closure.all? { |record| generation.generation_memberships.exists?(opaque_record: record) }
          unless bound_ids == dependency_ids && active_closure
            raise Coordination::OutcomeError.new("OBJECT_ID_CONFLICT", status: :conflict)
          end
          event_commit = existing
          retained_generation = generation
          retained_cursor = vault.head_cursor
          idempotency.persist!(resource_type: "EventCommit", resource_id: existing.id)
          next
        end
        bound_ids = event.record_dependencies.order(:ordinal).joins(:dependency_record).pluck("opaque_records.object_id")
        unless bound_ids == dependency_ids
          raise Coordination::OutcomeError.new("DEPENDENCY_INVALID", status: :unprocessable_content)
        end
        closure = [ event ] + event.record_dependencies.order(:ordinal).map(&:dependency_record)
        unless closure.all? { |record| record.state.in?([ "DurableUncommitted", "Committed" ]) && record.vault_replica == vault }
          raise Coordination::OutcomeError.new("OBJECT_NOT_DURABLE", status: :conflict)
        end
        closure.each do |record|
          record.update!(state: "Committed", committed_at: record.committed_at || Time.current)
          generation.generation_memberships.find_or_create_by!(opaque_record: record)
        end
        cursor = vault.head_cursor + 1
        event_commit = EventCommit.create!(vault_replica: vault, vault_generation: generation,
          event_record: event, cursor:, request_sha256:, committed_at: Time.current)
        DeliveryChange.create!(vault_replica: vault, vault_generation: generation,
          event_commit:, cursor:, kind: "EventCommitted", accepted_at: Time.current)
        vault.update!(head_cursor: cursor)
        idempotency.persist!(resource_type: "EventCommit", resource_id: event_commit.id)
      end
      if retained_generation
        render json: commit_json(event_commit, generation: retained_generation, cursor: retained_cursor)
      else
        Coordination::VaultNotifier.broadcast(vault.reload)
        render json: commit_json(event_commit)
      end
    rescue KeyError, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("DEPENDENCY_INVALID", status: :unprocessable_content)
    end

    private

    def account_vault!
      bound_vault!
    end

    def validate_dependencies!(ids)
      unless ids.is_a?(Array) && ids == ids.sort && ids.uniq == ids
        raise Coordination::OutcomeError.new("DEPENDENCY_INVALID", status: :unprocessable_content)
      end
    end

    def commit_json(commit, generation: commit.vault_generation, cursor: commit.cursor)
      ids = commit.event_record.record_dependencies.order(:ordinal).joins(:dependency_record).pluck("opaque_records.object_id")
      { eventObjectId: commit.event_record.object_id,
       generationId: generation.generation_id,
       generationNumber: generation.generation_number,
       dependencyObjectIds: ids, cursor:, durabilityAcknowledged: true }
    end
  end
end
