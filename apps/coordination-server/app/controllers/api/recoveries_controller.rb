module Api
  class RecoveriesController < BaseController
    def index
      recoveries = account_vault!.vault_generations.where(state: [ "Superseded", "Purging" ])
        .order(:generation_number).map do |generation|
        { generationId: generation.generation_id, generationNumber: generation.generation_number,
         supersededAt: Coordination::ProtocolEncoding.timestamp(generation.superseded_at),
         purgeAfter: Coordination::ProtocolEncoding.timestamp(generation.purge_after),
         state: generation.state, recordCount: generation.generation_memberships.count,
         byteLength: generation.opaque_records.sum(:byte_length) }
      end
      render json: { recoveries: }
    end

    def records
      generation = recovery!
      limit = Integer(params.fetch(:limit, 100).to_s, 10)
      maximum = Coordination::ServicePolicy.current.maximum_record_page_size
      raise ArgumentError unless limit.between?(1, maximum)
      relation = generation.opaque_records.where(state: "Committed").order(:object_id)
      relation = relation.where("object_id > ?", params[:afterObjectId]) if params[:afterObjectId].present?
      rows = relation.limit(limit + 1).to_a
      has_more = rows.length > limit
      rows = rows.first(limit)
      payload = { generationId: generation.generation_id, generationNumber: generation.generation_number,
                 records: rows.map { |record| Coordination::Serializers.record(record) }, hasMore: has_more }
      payload[:nextObjectId] = rows.last.object_id if has_more
      render json: payload
    rescue ArgumentError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    def download
      generation = recovery!
      record = generation.opaque_records.find_by!(object_id: params[:object_id], state: "Committed")
      ticket = Coordination::TransferTicketIssuer.download(account: current_account,
        vault: generation.vault_replica, record:, generation:, purpose: "RecoveryDownload")
      render json: { record: Coordination::Serializers.record(record), ticket: }
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("RECOVERY_NOT_FOUND", status: :not_found)
    end

    private

    def account_vault!
      bound_vault!
    end

    def recovery!
      generation = account_vault!.vault_generations.find_by!(generation_id: params[:generation_id])
      if generation.state == "Purging" || generation.purge_after&.past?
        raise Coordination::OutcomeError.new("RECOVERY_EXPIRED", status: :gone)
      end
      return generation if generation.state == "Superseded"
      raise Coordination::OutcomeError.new("RECOVERY_EXPIRED", status: :gone)
    rescue ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("RECOVERY_NOT_FOUND", status: :not_found)
    end
  end
end
