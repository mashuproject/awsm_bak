require "rails_helper"

RSpec.describe "Service policy", type: :request do
  def with_environment(name, value)
    original = ENV[name]
    ENV[name] = value
    yield
  ensure
    original.nil? ? ENV.delete(name) : ENV[name] = original
  end

  before do
    account = create_account
    allow(Coordination::AccountAuthenticator).to receive(:authenticate).and_return(
      Coordination::AccountPrincipal.new(account:, confirmed_at: Time.current)
    )
  end

  Given(:request_id) { "01900000-0000-7000-8000-000000000001" }
  Given(:headers) do
    {
      "Awsm-Protocol-Version" => "1",
      "Awsm-Request-ID" => request_id,
      "Authorization" => "Bearer proof-account-token"
    }
  end

  context "with the canonical protocol headers" do
    When { get "/api/service-policy", headers: headers }

    Then { response.status == 200 }
    And { response.headers.fetch("Awsm-Protocol-Version") == "1" }
    And { response.headers.fetch("Awsm-Request-ID") == request_id }
    And { response.parsed_body.fetch("inactive_account_retention_days") == 365 }
    And { response.parsed_body.fetch("maximum_compact_payload_bytes") == 16_777_216 }
    And { response.parsed_body.fetch("maximum_upload_part_bytes") == 8_388_608 }
  end

  context "with an unsupported protocol" do
    When { get "/api/service-policy", headers: headers.merge("Awsm-Protocol-Version" => "2") }

    Then { response.status == 400 }
    And { response.parsed_body.fetch("outcome") == "protocol_invalid" }
    And { response.parsed_body.fetch("request_id") == request_id }
  end

  it "accepts only a positive integer inactivity retention policy" do
    with_environment("AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS", "0") do
      expect { Coordination::ServicePolicy.current }.to raise_error(
        "AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS is outside its supported range"
      )
    end

    with_environment("AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS", "not-an-integer") do
      expect { Coordination::ServicePolicy.current }.to raise_error(
        "AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS must be an integer"
      )
    end
  end
end
