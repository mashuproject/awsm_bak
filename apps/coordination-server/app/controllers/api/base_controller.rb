module Api
  class BaseController < ProtocolController
    before_action :authenticate_account
    before_action :require_vault_device_scope
    around_action :fence_active_account_mutation
    after_action :record_account_activity

    attr_reader :current_account, :current_principal

    private

    def fence_active_account_mutation
      return yield if request.get? || request.head? || current_account.nil?

      ::Account.transaction do
        current_account.lock!
        unless current_account.active?
          raise Coordination::OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
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

    def require_account_scope
      return if current_principal.scope == "Account"

      raise Coordination::OutcomeError.new("AUTHORIZATION_FAILED", status: :forbidden)
    end

    def require_vault_device_scope
      if current_principal.scope == "VaultDevice"
        device = current_principal.session&.vault_device
        return if device&.active? && device.vault_replica.account_id == current_account.id

        raise Coordination::OutcomeError.new("DEVICE_REVOKED", status: :unauthorized)
      end

      raise Coordination::OutcomeError.new("AUTHORIZATION_FAILED", status: :forbidden)
    end

    def bound_vault!
      vault = current_principal.session&.vault_device&.vault_replica
      if vault.nil? || (params[:vault_id].present? && params[:vault_id] != vault.vault_id)
        raise Coordination::OutcomeError.new("VAULT_NOT_FOUND", status: :not_found)
      end
      vault
    end
  end
end
