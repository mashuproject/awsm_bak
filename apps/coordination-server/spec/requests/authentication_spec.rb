require "rails_helper"
require "base64"
require "stringio"

RSpec.describe "Account authentication", type: :request do
  let(:request_id) { "01900000-0000-7000-8000-000000000002" }
  let(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => request_id,
      "Idempotency-Key" => "01900000-0000-7000-8000-000000000003",
      "Content-Type" => "application/json"
    }
  end
  let(:authentication_secret) { Base64.urlsafe_encode64("a" * 32, padding: false) }
  let(:account_key_id) { "01900000-0000-7000-8000-000000000010" }
  let(:account_body) do
    {
      email: "Reader@Example.Test",
      authenticationSecret: authentication_secret,
      accountKeyEnvelope: {
        version: 1,
        accountKeyId: account_key_id,
        kdfAlgorithm: "kdf:argon2id13:account:v1",
        kdfSalt: [ "00" * 16 ].pack("H*").then { |bytes| Base64.urlsafe_encode64(bytes, padding: false) },
        kdfOperations: 3,
        kdfMemoryBytes: 67_108_864,
        wrappingAlgorithm: "wrap:xchacha20poly1305:account-password:v1",
        nonce: Base64.urlsafe_encode64("n" * 24, padding: false),
        ciphertext: Base64.urlsafe_encode64("c" * 48, padding: false)
      }
    }
  end

  def json_request(method, path, body:, headers:)
    public_send(method, path, params: body.to_json, headers: headers)
  end

  it "discovers the server without Account authentication" do
    get "/api/server-information", headers: headers.except("Content-Type")

    expect(response.status).to eq(200), response.body
    expect(response.parsed_body).to eq(
      "service" => "AWSM Coordination Server",
      "protocolVersion" => "1",
      "capabilities" => {
        "accountPassword" => true,
        "accountVaultLimit" => 1,
        "completeReplicaSynchronization" => true
      }
    )
  end

  it "returns real or stable synthetic public derivation parameters without revealing Account existence" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)

    json_request(:post, "/api/authentication-parameters",
      body: { email: "reader@example.test" }, headers: headers)
    existing = response.parsed_body
    expect(response).to have_http_status(:ok), response.body
    expect(existing).to include(
      "accountKeyId" => account_key_id,
      "kdfAlgorithm" => "kdf:argon2id13:account:v1",
      "kdfOperations" => 3,
      "kdfMemoryBytes" => 67_108_864
    )

    2.times do
      json_request(:post, "/api/authentication-parameters",
        body: { email: "missing@example.test" }, headers: headers)
      expect(response).to have_http_status(:ok)
      expect(response.parsed_body).not_to include("accountExists")
      @synthetic ||= response.parsed_body
      expect(response.parsed_body).to eq(@synthetic)
    end
    expect(@synthetic.fetch("accountKeyId")).not_to eq(existing.fetch("accountKeyId"))
  end

  it "creates a normalized Account and authenticated rotating session" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)

    expect(response).to have_http_status(:created)
    expect(response.parsed_body.dig("account", "email")).to eq("reader@example.test")
    expect(response.parsed_body.dig("account", "accountKeyEnvelope", "accountKeyId"))
      .to eq(account_key_id)
    expect(response.parsed_body.fetch("accessToken")).to be_present
    expect(response.parsed_body.fetch("refreshToken")).to be_present
    expect(Account.find_by!(email: "reader@example.test").vault_replicas).to be_empty

    access_token = response.parsed_body.fetch("accessToken")
    refresh_token = response.parsed_body.fetch("refreshToken")
    authenticated_headers = headers.except("Content-Type").merge("Authorization" => "Bearer #{access_token}")

    get "/api/service-policy", headers: authenticated_headers
    expect(response).to have_http_status(:ok)

    json_request(:post, "/api/session/refresh", body: { refreshToken: refresh_token }, headers: headers)
    expect(response).to have_http_status(:ok)
    expect(response.parsed_body.fetch("refreshToken")).not_to eq(refresh_token)

    json_request(:post, "/api/session/refresh", body: { refreshToken: refresh_token }, headers: headers)
    expect(response).to have_http_status(:unauthorized)
    expect(response.parsed_body.fetch("outcome")).to eq("AUTHENTICATION_FAILED")
  end

  it "replays a lost signup response without creating another Account" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)
    first_account_id = response.parsed_body.dig("account", "accountId")

    json_request(:post, "/api/accounts", body: account_body, headers: headers)

    expect(response).to have_http_status(:created)
    expect(response.parsed_body.dig("account", "accountId")).to eq(first_account_id)
    expect(Account.where(email: "reader@example.test").count).to eq(1)

    changed = account_body.merge(authenticationSecret: "B" * 43)
    json_request(:post, "/api/accounts", body: changed, headers: headers)
    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("IDEMPOTENCY_CONFLICT")
  end

  it "logs in without receiving the raw password and logs out the session" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)
    json_request(
      :post,
      "/api/sessions",
      body: { email: "reader@example.test", authenticationSecret: authentication_secret },
      headers: headers
    )

    expect(response).to have_http_status(:ok)
    access_token = response.parsed_body.fetch("accessToken")

    delete "/api/session", headers: headers.except("Content-Type").merge(
      "Authorization" => "Bearer #{access_token}"
    )
    expect(response).to have_http_status(:no_content)

    get "/api/service-policy", headers: headers.except("Content-Type").merge(
      "Authorization" => "Bearer #{access_token}"
    )
    expect(response).to have_http_status(:unauthorized)
  end

  it "does not disclose whether login email or authentication secret differed" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)

    attempts = 0
    verifier = BCrypt::Password.instance_method(:is_password?)
    allow_any_instance_of(BCrypt::Password).to receive(:is_password?) do |digest, candidate|
      attempts += 1
      verifier.bind_call(digest, candidate)
    end

    [
      { email: "missing@example.test", authenticationSecret: authentication_secret },
      { email: "reader@example.test", authenticationSecret: "B" * 43 }
    ].each do |body|
      before = attempts
      json_request(:post, "/api/sessions", body: body, headers: headers)
      expect(response).to have_http_status(:unauthorized)
      expect(response.parsed_body.fetch("outcome")).to eq("AUTHENTICATION_FAILED")
      expect(attempts - before).to eq(1)
    end
  end

  it "rejects a second Account using the same normalized email" do
    json_request(:post, "/api/accounts", body: account_body, headers: headers)
    json_request(:post, "/api/accounts", body: account_body,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000004"))

    expect(response).to have_http_status(:conflict)
    expect(response.parsed_body.fetch("outcome")).to eq("ACCOUNT_UNAVAILABLE")
  end

  it "filters credential sentinels from request logs, errors, model inspection, and Job arguments" do
    sentinels = {
      "email" => "sentinel-reader@example.test",
      "password" => "sentinel-password",
      "authenticationSecret" => authentication_secret,
      "accessToken" => "sentinel-access-token",
      "refreshToken" => "sentinel-refresh-token",
      "ticket" => "sentinel-cable-ticket",
      "accountKey" => "sentinel-account-key",
      "ciphertext" => account_body.dig(:accountKeyEnvelope, :ciphertext),
      "kdfSalt" => account_body.dig(:accountKeyEnvelope, :kdfSalt)
    }
    filtered = ActiveSupport::ParameterFilter
      .new(Rails.application.config.filter_parameters).filter(sentinels)
    expect(filtered.values).to all(eq("[FILTERED]"))

    io = StringIO.new
    prior_logger = Rails.logger
    Rails.logger = ActiveSupport::TaggedLogging.new(Logger.new(io))
    json_request(:post, "/api/accounts", body: account_body, headers: headers)
    account = Account.find_by!(email: "reader@example.test")
    malformed = account_body.merge(unexpectedSecret: "sentinel-unexpected-secret")
    json_request(:post, "/api/accounts", body: malformed,
      headers: headers.merge("Idempotency-Key" => "01900000-0000-7000-8000-000000000099"))
    expect(response).to have_http_status(:bad_request)

    exposed = [ io.string, response.body, account.inspect ].join("\n")
    sentinels.values.each { |sentinel| expect(exposed).not_to include(sentinel) }
  ensure
    Rails.logger = prior_logger if prior_logger
  end
end
