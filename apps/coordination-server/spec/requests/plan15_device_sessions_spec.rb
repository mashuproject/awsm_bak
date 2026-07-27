require "rails_helper"
require "digest"
require "openssl"
require "redis"

RSpec.describe "Plan 15 Device challenge sessions", type: :request do
  let(:account) do
    Account.create!(
      username: "reader",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )
  end
  let(:account_issued) { Coordination::SessionCredentials.issue(account:, scope: "Account") }
  let(:vault) do
    account.vault_replicas.create!(
      vault_id: "01900000-0000-7000-8000-000000000041",
      state: "Active",
      head_cursor: 1
    )
  end
  let(:recovery) do
    ciphertext = "encrypted recovery keyring"
    vault.recovery_generations.create!(
      id: "01900000-0000-7000-8000-000000000042",
      ordinal: 0,
      derivation_algorithm: RecoveryGeneration::DERIVATION_ALGORITHM,
      wrapping_algorithm: RecoveryGeneration::WRAPPING_ALGORITHM,
      administrator_signing_algorithm: RecoveryGeneration::SIGNING_ALGORITHM,
      administrator_public_key: "a" * 32,
      kit_nonce: "n" * 24,
      kit_ciphertext: ciphertext,
      kit_ciphertext_length: ciphertext.bytesize,
      kit_ciphertext_sha256: Digest::SHA256.digest(ciphertext),
      activated_at: Time.current
    )
  end
  let(:device_signing) { OpenSSL::PKey.generate_key("ED25519") }
  let(:device) do
    vault.vault_devices.create!(
      device_id: "01900000-0000-7000-8000-000000000043",
      recovery_generation: recovery,
      certificate_id: "01900000-0000-7000-8000-000000000044",
      display_name: "Firefox extension",
      client_kind: "FirefoxExtension",
      signing_algorithm: "sign:ed25519:device:v1",
      signing_public_key: device_signing.raw_public_key,
      wrapping_algorithm: "wrap:x25519-hkdf-sha256-xchacha20poly1305:device:v1",
      wrapping_public_key: "w" * 32,
      certificate_cbor: "certificate",
      certificate_signature: "s" * 64,
      enrolled_at: Time.current
    )
  end
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => "01900000-0000-7000-8000-000000000045",
      "Authorization" => "Bearer #{account_issued.fetch(:access_token)}",
      "Content-Type" => "application/json"
    }
  end

  def challenge!
    post "/api/device-session-challenges",
      params: { vaultId: vault.vault_id, deviceId: device.device_id }.to_json,
      headers: headers
    expect(response).to have_http_status(:created)
    response.parsed_body.fetch("challenge")
  end

  def signature_for(challenge, session_id: account_issued.fetch(:session).id)
    transcript = Coordination::CanonicalCbor.encode(
      "domain" => "awsm:device-session-challenge:v1",
      "accountSessionId" => session_id,
      "vaultId" => vault.vault_id,
      "deviceId" => device.device_id,
      "challenge" => Coordination::ProtocolEncoding.decode_base64url(challenge, bytes: 32)
    )
    Base64.urlsafe_encode64(device_signing.sign(nil, transcript), padding: false)
  end

  it "stores only a namespaced challenge digest with a 60-second Redis TTL" do
    challenge = challenge!
    redis = Redis.new(url: Coordination::EphemeralCoordination.url, reconnect_attempts: 0)
    key = Coordination::EphemeralCoordination.device_session_challenge_key(challenge)

    expect(challenge).to match(/\A[A-Za-z0-9_-]{43}\z/)
    expect(key).not_to include(challenge)
    expect(redis.exists?(key)).to be(true)
    expect(redis.ttl(key)).to be_between(1, 60)
  ensure
    redis&.del(key) if key
    redis&.close
  end

  it "consumes a valid signed challenge once and issues VaultDevice scope" do
    challenge = challenge!
    body = {
      vaultId: vault.vault_id,
      deviceId: device.device_id,
      challenge:,
      signature: signature_for(challenge)
    }

    post "/api/device-sessions", params: body.to_json, headers: headers

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("scope")).to eq("VaultDevice")
    expect(ApiSession.find(response.parsed_body.fetch("sessionId"))).to have_attributes(
      vault_device_id: device.device_id,
      scope: "VaultDevice"
    )

    post "/api/device-sessions", params: body.to_json, headers: headers
    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHENTICATION_FAILED")
  end

  it "consumes and rejects a challenge used by another Account session" do
    challenge = challenge!
    second = Coordination::SessionCredentials.issue(account:, scope: "Account")
    other_headers = headers.merge("Authorization" => "Bearer #{second.fetch(:access_token)}")

    post "/api/device-sessions",
      params: {
        vaultId: vault.vault_id,
        deviceId: device.device_id,
        challenge:,
        signature: signature_for(challenge)
      }.to_json,
      headers: other_headers

    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHENTICATION_FAILED")
  end

  it "fails safely when Redis is unavailable" do
    allow(Coordination::EphemeralCoordination).to receive(:with_redis)
      .and_raise(Redis::CannotConnectError)

    post "/api/device-session-challenges",
      params: { vaultId: vault.vault_id, deviceId: device.device_id }.to_json,
      headers: headers

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body).to include(
      "outcome" => "AUTHENTICATION_UNAVAILABLE",
      "retryable" => true
    )
  end
end
