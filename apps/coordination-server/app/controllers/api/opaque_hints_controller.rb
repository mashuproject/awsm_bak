module Api
  class OpaqueHintsController < BaseController
    def show
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.hint.read")
      render_hint(grant.hosted_replica.hint_cursor)
    end

    def create
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.hint.write")
      cursor = HostedReplica.transaction do
        replica = grant.hosted_replica.lock!
        grant.lock!
        unless replica.active? && grant.permits?("awsm.replica.hint.write")
          raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
        end

        replica.update!(hint_cursor: replica.hint_cursor + 1)
        replica.hint_cursor
      end
      render_hint(cursor)
    end

    private

    def render_hint(cursor)
      render json: { hint_cursor: cursor }
    end
  end
end
