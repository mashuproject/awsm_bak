module Api
  module Account
    class VaultEnrollmentsController < BaseController
      skip_before_action :require_vault_device_scope
      before_action :require_account_scope

      def show
        vault = current_account.vault_replicas.find_by(state: "Active")
        return render json: { state: "Empty" } unless vault

        recovery_generation = vault.active_recovery_generation
        unless recovery_generation&.activated_at? && recovery_generation.retired_at.nil? &&
            recovery_generation.kit_ciphertext.present?
          raise Coordination::OutcomeError.new("ACCOUNT_UNAVAILABLE", status: :service_unavailable,
            retryable: true)
        end

        render json: {
          state: "Attached",
          vaultId: vault.vault_id,
          recoveryKit: Coordination::RecoveryKit.encode(recovery_generation)
        }
      end
    end
  end
end
