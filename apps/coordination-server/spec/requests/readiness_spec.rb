require "rails_helper"

RSpec.describe "Readiness", type: :request do
  it "reports every ready component" do
    get "/ready"

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "status" => "ready",
      "components" => {
        "database" => "ready",
        "opaqueByteStorage" => "ready",
        "ephemeralCoordination" => "ready"
      }
    )
  end

  it "remains ready for HTTP synchronization when only Redis is unavailable" do
    allow(Coordination::EphemeralCoordination).to receive(:ping)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")
    expect(Rails.error).to receive(:report) do |error, handled:, context:|
      expect(error.message).to eq("ephemeral_coordination_unavailable")
      expect(handled).to be(true)
      expect(context).to eq(component: "readiness", probe: "ephemeralCoordination")
      expect([ error, context ].inspect).not_to include("credential-sentinel")
    end

    get "/ready"

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "status" => "degraded",
      "components" => {
        "database" => "ready",
        "opaqueByteStorage" => "ready",
        "ephemeralCoordination" => "unavailable"
      }
    )
  end

  it "reports unavailable while still probing Redis when a critical component fails" do
    allow(ActiveRecord::Base.connection).to receive(:select_value).and_raise("database unavailable")
    expect(Coordination::EphemeralCoordination).to receive(:ping).and_return("PONG")
    allow(Rails.error).to receive(:report)

    get "/ready"

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body.dig("components", "database")).to eq("unavailable")
    expect(response.parsed_body.dig("components", "ephemeralCoordination")).to eq("ready")
  end

  it "reports unavailable when byte storage and Redis both fail" do
    allow(Coordination::DiskStore).to receive(:root).and_raise("storage unavailable")
    allow(Coordination::EphemeralCoordination).to receive(:ping)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")
    allow(Rails.error).to receive(:report)

    get "/ready"

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body).to eq(
      "status" => "unavailable",
      "components" => {
        "database" => "ready",
        "opaqueByteStorage" => "unavailable",
        "ephemeralCoordination" => "unavailable"
      }
    )
  end
end
