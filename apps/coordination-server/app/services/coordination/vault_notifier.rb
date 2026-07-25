module Coordination
  class VaultNotifier
    def self.broadcast(vault)
      VaultChangesChannel.broadcast_to(vault,
        { vaultId: vault.vault_id, latestCursor: vault.head_cursor })
    rescue StandardError => error
      reported_error = if error.is_a?(Redis::BaseError)
        EphemeralCoordination.unavailable_error
      else
        error
      end
      Rails.error.report(reported_error, handled: true,
        context: { component: "vault_change_hint" })
    end
  end
end
