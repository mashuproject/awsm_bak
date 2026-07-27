require "rails_helper"
require "digest"
require "openssl"

RSpec.describe "Plan 15 initial Vault attach", type: :request do
  let(:account) do
    Account.create!(
      username: "reader",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )
  end
  let(:vault_id) { "01900000-0000-7000-8000-000000000011" }
  let(:recovery_generation_id) { "01900000-0000-7000-8000-000000000012" }
  let(:key_epoch_id) { "01900000-0000-7000-8000-000000000013" }
  let(:activated_at) { Time.utc(2026, 7, 27, 12).iso8601(3) }
  let(:device_id) { "01900000-0000-7000-8000-000000000014" }
  let(:certificate_id) { "01900000-0000-7000-8000-000000000015" }
  let(:generation_id) { "01900000-0000-7000-8000-000000000017" }
  let(:administrator) { OpenSSL::PKey.generate_key("ED25519") }
  let(:device_signing) { OpenSSL::PKey.generate_key("ED25519") }
  let(:recovery_ciphertext) { "encrypted recovery keyring" }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000021",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000022",
      "Authorization" => "Bearer #{account_access_token}",
      "Content-Type" => "application/json"
    }
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  def login!
    post "/api/sessions",
      params: { username: account.username, password: "correct horse battery staple" }.to_json,
      headers: {
        "Awsm-Protocol-Version" => "1",
        "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000020",
        "Content-Type" => "application/json"
      }
    expect(response).to have_http_status(:ok)
    @account_access_token = response.parsed_body.fetch("accessToken")
    @account_session_id = response.parsed_body.fetch("sessionId")
  end

  def account_access_token
    @account_access_token || raise("login! was not called")
  end

  def account_session_id
    @account_session_id || raise("login! was not called")
  end

  def attach_body
    certificate_content = {
      "version" => 1,
      "certificateId" => certificate_id,
      "vaultId" => vault_id,
      "recoveryGenerationId" => recovery_generation_id,
      "deviceId" => device_id,
      "displayName" => "Firefox extension",
      "clientKind" => "FirefoxExtension",
      "signingAlgorithm" => "sign:ed25519:device:v1",
      "signingPublicKey" => device_signing.raw_public_key,
      "wrappingAlgorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "wrappingPublicKey" => "w" * 32,
      "issuedAt" => Time.current.utc.iso8601(3)
    }
    certificate_cbor = Coordination::CanonicalCbor.encode(certificate_content)
    certificate_signature = administrator.sign(nil, certificate_cbor)
    certificate = {
      content: encode(certificate_cbor),
      recoveryAdministratorPublicKey: encode(administrator.raw_public_key),
      signature: encode(certificate_signature)
    }
    envelope_metadata = {
      "version" => 1,
      "vaultId" => vault_id,
      "recoveryGenerationId" => recovery_generation_id,
      "keyEpochId" => key_epoch_id,
      "deviceId" => device_id,
      "algorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "ephemeralPublicKey" => "e" * 32,
      "nonce" => "n" * 24,
      "ciphertextLength" => 48
    }
    envelope_ciphertext = "c" * 48
    envelope_sha256 = Digest::SHA256.digest(envelope_ciphertext)
    envelope_signature_payload = Coordination::CanonicalCbor.encode(
      "metadata" => envelope_metadata,
      "ciphertextSha256" => envelope_sha256
    )
    enrollment_transcript = Coordination::CanonicalCbor.encode(
      "domain" => "awsm:device-enrollment-proof:v1",
      "certificateSha256" => Digest::SHA256.digest(certificate_cbor),
      "certificateSignatureSha256" => Digest::SHA256.digest(certificate_signature),
      "accountSessionId" => account_session_id
    )

    {
      vaultId: vault_id,
      recoveryGeneration: {
        version: 1,
        vaultId: vault_id,
        recoveryGenerationId: recovery_generation_id,
        derivationAlgorithm: "kdf:hkdf-sha256:recovery-entropy:v1",
        wrappingAlgorithm: "wrap:xchacha20poly1305:recovery-kit:v1",
        administratorSigningAlgorithm: "sign:ed25519:recovery-administrator:v1",
        administratorPublicKey: encode(administrator.raw_public_key),
        nonce: encode("r" * 24),
        ciphertextLength: recovery_ciphertext.bytesize,
        ciphertextSha256: encode(Digest::SHA256.digest(recovery_ciphertext)),
        ciphertext: encode(recovery_ciphertext)
      },
      keyEpochs: [ { keyEpochId: key_epoch_id, ordinal: 0, activatedAt: activated_at } ],
      activeKeyEpochId: key_epoch_id,
      deviceCertificate: certificate,
      deviceKeyEnvelopes: [ {
        metadata: encode(Coordination::CanonicalCbor.encode(envelope_metadata)),
        ciphertext: encode(envelope_ciphertext),
        ciphertextSha256: encode(envelope_sha256),
        administratorSignature: encode(administrator.sign(nil, envelope_signature_payload))
      } ],
      deviceProofSignature: encode(device_signing.sign(nil, enrollment_transcript)),
      generationId: generation_id,
      generationNumber: 0,
      generationObject: {
        objectId: generation_id,
        objectType: "VaultGeneration",
        keyEpochId: key_epoch_id,
        byteLength: 10,
        sha256: encode(Digest::SHA256.digest("generation"))
      }
    }
  end

  before do
    account
    login!
  end

  it "atomically creates recovery authority, the first Device, epoch envelope, and Device session" do
    post "/api/vaults", params: attach_body.to_json, headers: headers

    expect(response).to have_http_status(:created), response.body
    expect(response.parsed_body.dig("session", "scope")).to eq("VaultDevice")
    vault = account.vault_replicas.find_by!(vault_id:)
    expect(vault).to have_attributes(
      state: "Provisional",
      active_key_epoch_id: key_epoch_id,
      active_recovery_generation_id: recovery_generation_id
    )
    expect(vault.recovery_generations.find(recovery_generation_id)).to have_attributes(
      ordinal: 0,
      administrator_public_key: administrator.raw_public_key
    )
    expect(vault.vault_key_epochs.find(key_epoch_id)).to have_attributes(ordinal: 0)
    expect(vault.vault_devices.find(device_id)).to have_attributes(
      certificate_id:,
      recovery_generation_id:
    )
    expect(DeviceKeyEnvelope.find_by!(
      vault_device_id: device_id,
      vault_key_epoch_id: key_epoch_id
    )).to be_present
    expect(ApiSession.find(response.parsed_body.dig("session", "sessionId"))).to have_attributes(
      account:,
      scope: "VaultDevice",
      vault_device_id: device_id
    )
    expect(OpaqueRecord.find_by!(object_id: generation_id).vault_key_epoch_id).to eq(key_epoch_id)
  end

  it "creates a complete contiguous multi-epoch authority and uses the active final epoch" do
    second_epoch_id = "01900000-0000-7000-8000-000000000023"
    body = attach_body
    second_metadata = {
      "version" => 1,
      "vaultId" => vault_id,
      "recoveryGenerationId" => recovery_generation_id,
      "keyEpochId" => second_epoch_id,
      "deviceId" => device_id,
      "algorithm" => "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      "ephemeralPublicKey" => "f" * 32,
      "nonce" => "o" * 24,
      "ciphertextLength" => 48
    }
    second_ciphertext = "d" * 48
    second_sha256 = Digest::SHA256.digest(second_ciphertext)
    second_signature_payload = Coordination::CanonicalCbor.encode(
      "metadata" => second_metadata,
      "ciphertextSha256" => second_sha256
    )
    body[:keyEpochs] << {
      keyEpochId: second_epoch_id,
      ordinal: 1,
      activatedAt: Time.utc(2026, 7, 27, 13).iso8601(3)
    }
    body[:activeKeyEpochId] = second_epoch_id
    body[:deviceKeyEnvelopes] << {
      metadata: encode(Coordination::CanonicalCbor.encode(second_metadata)),
      ciphertext: encode(second_ciphertext),
      ciphertextSha256: encode(second_sha256),
      administratorSignature: encode(administrator.sign(nil, second_signature_payload))
    }
    body[:generationObject][:keyEpochId] = second_epoch_id

    post "/api/vaults", params: body.to_json, headers: headers

    expect(response).to have_http_status(:created), response.body
    vault = account.vault_replicas.find_by!(vault_id:)
    expect(vault.active_key_epoch_id).to eq(second_epoch_id)
    expect(vault.vault_key_epochs.order(:ordinal).pluck(:id, :ordinal)).to eq(
      [ [ key_epoch_id, 0 ], [ second_epoch_id, 1 ] ]
    )
    expect(vault.vault_devices.find(device_id).device_key_envelopes.count).to eq(2)
    expect(OpaqueRecord.find_by!(object_id: generation_id).vault_key_epoch_id).to eq(second_epoch_id)
  end

  it "rejects the discarded single-epoch attachment shape" do
    body = attach_body
    body[:keyEpoch] = body.delete(:keyEpochs).first.except(:activatedAt)
    body[:deviceKeyEnvelope] = body.delete(:deviceKeyEnvelopes).first
    body.delete(:activeKeyEpochId)

    post "/api/vaults", params: body.to_json, headers: headers

    expect(response).to have_http_status(:bad_request)
    expect(response.parsed_body.fetch("outcome")).to eq("REQUEST_INVALID")
    expect(account.vault_replicas).to be_empty
  end

  it "rejects noncontiguous epochs, missing envelopes, and a non-final active epoch" do
    [
      ->(body) { body[:keyEpochs].first[:ordinal] = 1 },
      ->(body) { body[:deviceKeyEnvelopes] = [] },
      ->(body) { body[:activeKeyEpochId] = SecureRandom.uuid }
    ].each do |corrupt|
      body = attach_body
      corrupt.call(body)

      post "/api/vaults", params: body.to_json, headers: headers

      expect(response).to have_http_status(:bad_request)
      expect(response.parsed_body.fetch("outcome")).to eq("REQUEST_INVALID")
      expect(account.vault_replicas).to be_empty
    end
  end

  it "rolls back every authority record when Device possession proof is invalid" do
    invalid = attach_body.merge(deviceProofSignature: encode("x" * 64))

    post "/api/vaults", params: invalid.to_json, headers: headers

    expect(response).to have_http_status(:unprocessable_content)
    expect(response.parsed_body.fetch("outcome")).to eq("DEVICE_ENROLLMENT_INVALID")
    expect(account.vault_replicas).to be_empty
    expect(RecoveryGeneration.count).to eq(0)
    expect(VaultKeyEpoch.count).to eq(0)
    expect(VaultDevice.count).to eq(0)
    expect(DeviceKeyEnvelope.count).to eq(0)
  end

  it "replays the same attach without duplicating authority and rejects changed bytes" do
    body = attach_body
    post "/api/vaults", params: body.to_json, headers: headers
    expect(response).to have_http_status(:created)

    post "/api/vaults", params: body.to_json, headers: headers
    expect(response).to have_http_status(:created)
    expect(account.vault_replicas.count).to eq(1)
    expect(VaultDevice.count).to eq(1)
    expect(DeviceKeyEnvelope.count).to eq(1)

    changed = body.deep_dup
    changed[:generationObject][:byteLength] = 11
    post "/api/vaults", params: changed.to_json, headers: headers
    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("IDEMPOTENCY_CONFLICT")
  end

  it "rejects initial attach under a VaultDevice-scoped credential" do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000091",
      state: "Provisional",
      head_cursor: 0
    )
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(
        account:,
        confirmed_at: Time.current,
        session: instance_double(ApiSession, id: SecureRandom.uuid, active?: true),
        scope: "VaultDevice"
      )
    )

    post "/api/vaults", params: attach_body.to_json, headers: headers

    expect(response).to have_http_status(:forbidden)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHORIZATION_FAILED")
  end

  it "stages and atomically activates a full-re-encryption replacement" do
    source = account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000081",
      state: "Active",
      head_cursor: 7
    )
    principal = create_vault_device_principal(account:, vault: source)
    source_generation = source.vault_generations.create!(
      generation_id: "01900000-0000-7000-8000-000000000082",
      generation_number: 3,
      state: "Active"
    )
    source_epoch = source.vault_key_epochs.first!
    source_event = source.opaque_records.create!(
      object_id: "01900000-0000-7000-8000-000000000092",
      object_type: "Event",
      byte_length: 5,
      sha256: Digest::SHA256.digest("source event"),
      state: "Committed",
      target_generation_id: source_generation.generation_id,
      committed_at: Time.current,
      durable_at: Time.current,
      vault_key_epoch: source_epoch,
      storage_key: "objects/01900000-0000-7000-8000-000000000092",
      event_ordering_timestamp: Time.utc(2026, 7, 25, 19)
    )
    source_generation.generation_memberships.create!(opaque_record: source_event)
    source_commit = EventCommit.create!(
      vault_replica: source,
      vault_generation: source_generation,
      event_record: source_event,
      cursor: 7,
      request_sha256: Digest::SHA256.digest("source request"),
      committed_at: Time.current
    )
    DeliveryChange.create!(
      vault_replica: source,
      vault_generation: source_generation,
      event_commit: source_commit,
      cursor: 7,
      kind: "EventCommitted",
      accepted_at: Time.current
    )
    source.update!(
      active_generation: source_generation,
      active_generation_number: source_generation.generation_number,
      active_key_epoch: source_epoch
    )
    source_issued = Coordination::SessionCredentials.issue(
      account:,
      scope: "VaultDevice",
      vault_device_id: principal.session.vault_device_id
    )
    source_headers = headers.merge(
      "Authorization" => "Bearer #{source_issued.fetch(:access_token)}"
    )
    replacement_request = {
      accountSessionId: account_session_id,
      expectedSourceGenerationId: source_generation.generation_id,
      expectedSourceGenerationNumber: source_generation.generation_number,
      expectedSourceHeadCursor: source.head_cursor,
      replacement: attach_body
    }

    post "/api/vaults/#{source.vault_id}/replacement-candidates",
      params: replacement_request.to_json,
      headers: source_headers

    expect(response).to have_http_status(:created), response.body
    replacement_access = response.parsed_body.dig("session", "accessToken")
    replacement = account.vault_replicas.find_by!(vault_id:)
    expect(source.reload.state).to eq("Active")
    expect(replacement.state).to eq("Provisional")

    replacement.vault_generations.find_by!(generation_id:).generation_record.update!(
      state: "DurableUncommitted",
      durable_at: Time.current
    )
    replacement_headers = source_headers.merge(
      "Authorization" => "Bearer #{replacement_access}",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000083",
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000084"
    )
    post "/api/vaults/#{vault_id}/complete",
      params: { generationId: generation_id }.to_json,
      headers: replacement_headers

    expect(response).to have_http_status(:ok), response.body
    expect(replacement.reload.state).to eq("Provisional")
    expect(replacement.active_generation.generation_id).to eq(generation_id)
    replacement_object_id = "01900000-0000-7000-8000-000000000087"
    replacement_event_id = "01900000-0000-7000-8000-000000000088"
    replacement_object = replacement.opaque_records.create!(
      object_id: replacement_object_id,
      object_type: "Artifact",
      byte_length: 5,
      sha256: Digest::SHA256.digest("replacement object"),
      state: "DurableUncommitted",
      target_generation_id: generation_id,
      durable_at: Time.current,
      vault_key_epoch_id: key_epoch_id,
      storage_key: "objects/#{replacement_object_id}"
    )
    replacement_event = replacement.opaque_records.create!(
      object_id: replacement_event_id,
      object_type: "Event",
      byte_length: 5,
      sha256: Digest::SHA256.digest("replacement event"),
      state: "DurableUncommitted",
      target_generation_id: generation_id,
      durable_at: Time.current,
      vault_key_epoch_id: key_epoch_id,
      storage_key: "objects/#{replacement_event_id}",
      event_ordering_timestamp: Time.utc(2026, 7, 25, 20)
    )
    replacement_event.record_dependencies.create!(
      dependency_record: replacement_object,
      ordinal: 0
    )
    post "/api/vaults/#{vault_id}/commits",
      params: {
        generationId: generation_id,
        generationNumber: 0,
        eventObjectId: replacement_event_id,
        dependencyObjectIds: [ replacement_object_id ]
      }.to_json,
      headers: replacement_headers.merge(
        "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000089",
        "Idempotency-Key" => "01900000-0000-7000-8000-000000000090"
      )

    expect(response).to have_http_status(:ok), response.body
    expect(response.parsed_body).to include(
      "generationId" => generation_id,
      "generationNumber" => 0,
      "cursor" => 2
    )
    expect(replacement.reload.state).to eq("Provisional")
    expect(source.reload).to have_attributes(state: "Active", head_cursor: 7)
    expect(
      replacement.active_generation.opaque_records.pluck(:object_id)
    ).to include(replacement_object_id, replacement_event_id)
    get "/api/vaults/#{vault_id}/records?limit=100",
      headers: replacement_headers.except("Idempotency-Key", "Content-Type")

    expect(response).to have_http_status(:ok), response.body
    expect(response.parsed_body.fetch("records").pluck("objectId")).to contain_exactly(
      generation_id,
      replacement_object_id,
      replacement_event_id
    )
    expect(replacement.reload.state).to eq("Provisional")
    expect(source.reload).to have_attributes(state: "Active", head_cursor: 7)
    activation = {
      expectedSourceGenerationId: source_generation.generation_id,
      expectedSourceGenerationNumber: source_generation.generation_number,
      expectedSourceHeadCursor: source.head_cursor,
      replacementGenerationId: generation_id,
      replacementGenerationNumber: 0
    }
    post "/api/vaults/#{source.vault_id}/replacement-candidates/#{vault_id}/activate",
      params: activation.to_json,
      headers: replacement_headers.merge(
        "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000085",
        "Idempotency-Key" => "01900000-0000-7000-8000-000000000086"
      )

    expect(response).to have_http_status(:accepted), response.body
    expect(source.reload).to have_attributes(state: "Replaced", replaced_at: be_present)
    expect(replacement.reload.state).to eq("Active")
    expect(source.vault_devices.reload).to all have_attributes(
      revocation_reason: "VaultReencrypted",
      revoked_at: be_present
    )
    purge = source.purge_jobs.find_by!(reason: "VaultReplacement")
    expect(purge).to have_attributes(
      state: "Pending",
      stage: "Detach"
    )
    get "/api/vaults/#{source.vault_id}/purges/#{purge.id}",
      headers: replacement_headers.except("Idempotency-Key", "Content-Type")

    expect(response).to have_http_status(:ok), response.body
    expect(response.parsed_body).to include(
      "purgeId" => purge.id,
      "state" => "Pending",
      "stage" => "Detach"
    )
    expect(DeliveryChange.where(vault_replica: source).where.not(event_commit: nil)).to exist
    PurgeGenerationJob.perform_now(purge.id)
    expect(purge.reload).to have_attributes(state: "Succeeded", stage: "Complete")
    expect(DeliveryChange.where(vault_replica: source)).to be_empty
    expect(EventCommit.where(vault_replica: source)).to be_empty
    expect(source.vault_generations.reload).to be_empty
    expect(source.recovery_generations.reload).to all have_attributes(
      kit_ciphertext: nil,
      retired_at: be_present
    )
  end
end
