module Api
  class ChangesController < BaseController
    def index
      vault = bound_vault!
      generation = vault.active_generation
      unless generation
        raise Coordination::OutcomeError.new("VAULT_NOT_READY", status: :conflict)
      end
      if params[:generationId].present? && params[:generationId] != generation.generation_id
        raise Coordination::OutcomeError.new("VAULT_GENERATION_SUPERSEDED", status: :conflict,
          details: { currentGenerationId: generation.generation_id,
                     currentGenerationNumber: generation.generation_number,
                     headCursor: vault.head_cursor })
      end
      after = Integer(params.fetch(:after).to_s, 10)
      limit = Integer(params.fetch(:limit, 100).to_s, 10)
      maximum = Coordination::ServicePolicy.current.maximum_changes_page_size
      raise ArgumentError unless after >= 0 && limit.between?(1, maximum)
      snapshot = params[:snapshot].present? ? Integer(params[:snapshot].to_s, 10) : vault.head_cursor
      raise ArgumentError unless snapshot.between?(after, vault.head_cursor)
      rows = vault.delivery_changes.where(cursor: (after + 1)..snapshot).order(:cursor).limit(limit + 1).to_a
      has_more = rows.length > limit
      rows = rows.first(limit)
      render json: { generationId: generation.generation_id,
                    generationNumber: generation.generation_number,
                    changes: rows.map { |change| change_json(change) },
                    nextCursor: rows.last&.cursor || after,
                    snapshotCursor: snapshot, hasMore: has_more }
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
    rescue ArgumentError, KeyError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    private

    def change_json(change)
      result = { cursor: change.cursor, kind: change.kind,
                generationId: change.vault_generation.generation_id,
                acceptedAt: Coordination::ProtocolEncoding.timestamp(change.accepted_at) }
      result[:event] = Coordination::Serializers.record(change.event_commit.event_record) if change.event_commit
      result
    end
  end
end
