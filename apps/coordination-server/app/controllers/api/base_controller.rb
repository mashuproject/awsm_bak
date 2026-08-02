module Api
  class BaseController < ProtocolController
    before_action :authenticate_account
    around_action :fence_active_account_mutation
    after_action :record_account_activity

    attr_reader :current_account, :current_principal

    private

    def fence_active_account_mutation
      return yield if request.get? || request.head? || current_account.nil?

      ::Account.transaction do
        current_account.lock!
        unless current_account.active?
          raise Coordination::OutcomeError.new("authentication_required", status: :unauthorized)
        end
        yield
      end
    end

    def authenticate_account
      @current_principal = Coordination::AccountAuthenticator.authenticate(request)
      @current_account = current_principal.account
    end

    def record_account_activity
      return unless response.successful? && current_account

      Coordination::AccountActivity.touch!(account: current_account)
    end

    def require_replica_capability!(replica, capability)
      grant = current_principal.channel_principal.replica_access_grants
        .find_by(hosted_replica: replica, revoked_at: nil)
      return grant if grant&.permits?(capability)

      raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
    end

    def current_replica_grant!(replica_handle, capability)
      grant = current_principal.channel_principal.replica_access_grants
        .includes(:hosted_replica)
        .find_by(hosted_replica_id: replica_handle, revoked_at: nil)
      unless grant&.hosted_replica&.active?
        raise Coordination::OutcomeError.new("replica_not_found", status: :not_found)
      end
      return grant if grant.permits?(capability)

      raise Coordination::OutcomeError.new("access_denied", status: :forbidden)
    end
  end
end
