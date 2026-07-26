module Api
  class VaultsController < BaseController
    skip_before_action :require_vault_device_scope, only: :create
    before_action :require_account_scope, only: :create

    def create
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "AttachVault")
      if (replay = idempotency.replay)
        vault = current_account.vault_replicas.find(replay.resource_id)
        device = vault.vault_devices.find_by!(revoked_at: nil)
        issued = Coordination::SessionCredentials.issue(
          account: current_account, scope: "VaultDevice", vault_device_id: device.device_id
        )
        return render_attachment(vault, issued:, status: :created)
      end

      body = request.request_parameters
      if current_account.vault_replicas.where(state: %w[Provisional Active]).exists?
        raise Coordination::OutcomeError.new("ACCOUNT_VAULT_LIMIT", status: :conflict)
      end
      if VaultReplica.exists?(vault_id: body.fetch("vaultId"))
        raise Coordination::OutcomeError.new("VAULT_ID_UNAVAILABLE", status: :conflict)
      end

      vault = nil
      issued = nil
      VaultReplica.transaction do
        attached = Coordination::VaultAttachment.new(
          account: current_account,
          account_session_id: current_principal.session.id,
          body:
        ).create!
        vault = attached.vault
        device = attached.device
        issued = Coordination::SessionCredentials.issue(
          account: current_account, scope: "VaultDevice", vault_device_id: device.device_id
        )
        idempotency.persist!(resource_type: "VaultReplica", resource_id: vault.id)
      end
      render_attachment(vault, issued:, status: :created)
    rescue KeyError, ActiveRecord::RecordInvalid, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    rescue ActiveRecord::RecordNotUnique
      outcome = VaultReplica.exists?(vault_id: body&.fetch("vaultId", nil)) ?
        "VAULT_ID_UNAVAILABLE" : "ACCOUNT_VAULT_LIMIT"
      raise Coordination::OutcomeError.new(outcome, status: :conflict)
    end

    def index
      render json: { vaults: [ Coordination::Serializers.vault(bound_vault!) ] }
    end

    def show
      render json: Coordination::Serializers.vault(account_vault!)
    end

    def complete
      idempotency = Coordination::Idempotency.new(account: current_account, request:,
        operation: "CompleteVault")
      if (replay = idempotency.replay)
        return render json: Coordination::Serializers.vault(VaultReplica.find(replay.resource_id))
      end

      vault = account_vault!
      generation_id = request.request_parameters.fetch("generationId")
      VaultReplica.transaction do
        vault.lock!
        generation = vault.vault_generations.find_by!(generation_id:)
        record = generation.generation_record
        unless vault.state == "Provisional" && generation.state == "Candidate" &&
            record&.state == "DurableUncommitted"
          raise Coordination::OutcomeError.new("VAULT_NOT_READY", status: :conflict)
        end
        record.update!(state: "Committed", committed_at: Time.current)
        generation.generation_memberships.create!(opaque_record: record)
        generation.update!(state: "Active", activated_at: Time.current)
        replacing = vault.account.vault_replicas.where(state: "Active").where.not(id: vault.id)
          .exists?
        vault.update!(state: replacing ? "Provisional" : "Active", active_generation: generation,
          active_generation_number: generation.generation_number, head_cursor: 1,
          provisional_expires_at: replacing ? vault.provisional_expires_at : nil)
        DeliveryChange.create!(vault_replica: vault, vault_generation: generation, cursor: 1,
          kind: "GenerationActivated", accepted_at: Time.current)
        idempotency.persist!(resource_type: "VaultReplica", resource_id: vault.id)
      end
      vault.reload
      Coordination::VaultNotifier.broadcast(vault)
      render json: Coordination::Serializers.vault(vault)
    rescue KeyError, ActiveRecord::RecordNotFound
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    private

    def account_vault!
      bound_vault!
    end

    def render_attachment(vault, issued:, status:)
      generation = vault.active_generation || vault.vault_generations.find_by!(state: "Candidate")
      upload = generation.generation_record.upload
      render json: { vault: Coordination::Serializers.vault(vault),
                    upload: Coordination::Serializers.upload(upload),
                    ticket: Coordination::TransferTicketIssuer.upload(account: current_account,
                      vault:, upload:),
                    session: Coordination::AccountPayload.response(
                      account: current_account, issued:
                    ) }, status:
    end
  end
end
