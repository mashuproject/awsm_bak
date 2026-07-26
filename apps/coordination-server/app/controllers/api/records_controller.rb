module Api
  class RecordsController < BaseController
    def index
      vault = account_vault!
      ensure_readable!(vault)
      limit = requested_limit
      relation = vault.active_generation.opaque_records.where(state: "Committed").order(:object_id)
      relation = relation.where("object_id > ?", params[:afterObjectId]) if params[:afterObjectId].present?
      records = relation.limit(limit + 1).to_a
      has_more = records.length > limit
      records = records.first(limit)
      payload = { generationId: vault.active_generation.generation_id,
                 generationNumber: vault.active_generation.generation_number,
                 records: records.map { |record| Coordination::Serializers.record(record) },
                 hasMore: has_more }
      payload[:nextObjectId] = records.last.object_id if has_more
      render json: payload
    end

    def download
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CreateActiveDownload")
      vault = account_vault!
      ensure_readable!(vault)
      record = if (replay = idempotency.replay)
        OpaqueRecord.find(replay.resource_id)
      else
        candidate = vault.opaque_records.find_by!(object_id: params[:object_id], state: "Committed")
        unless vault.active_generation.generation_memberships.exists?(opaque_record: candidate)
          raise Coordination::OutcomeError.new("OBJECT_NOT_ACTIVE", status: :not_found)
        end
        idempotency.persist!(resource_type: "OpaqueRecord", resource_id: candidate.id)
        candidate
      end
      ticket = Coordination::TransferTicketIssuer.download(account: current_account, vault:,
        record:, generation: vault.active_generation)
      render json: { record: Coordination::Serializers.record(record), ticket: }
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("OBJECT_NOT_ACTIVE", status: :not_found)
    end

    private

    def account_vault!
      bound_vault!
    end

    def ensure_readable!(vault)
      return if vault.state.in?(%w[Active Provisional]) && vault.active_generation
      raise Coordination::OutcomeError.new("VAULT_NOT_READY", status: :conflict)
    end

    def requested_limit
      limit = Integer(params.fetch(:limit, 100).to_s, 10)
      maximum = Coordination::ServicePolicy.current.maximum_record_page_size
      raise ArgumentError unless limit.between?(1, maximum)
      limit
    rescue ArgumentError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end
  end
end
