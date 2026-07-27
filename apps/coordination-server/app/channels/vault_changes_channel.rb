class VaultChangesChannel < ApplicationCable::Channel
  def subscribed
    current_account.with_lock do
      return reject unless current_account.active?
      vault = current_account.vault_replicas.find_by(vault_id: params["vaultId"])
      return reject unless vault
      stream_for vault
    end
  end
end
