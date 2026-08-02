require "rails_helper"

RSpec.describe "Readiness", type: :request do
  it "reports every ready component" do
    get "/ready"

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq(
      "status" => "ready",
      "components" => {
        "database" => "ready",
        "opaqueByteStorage" => "ready"
      }
    )
  end

  it "reports unavailable when the database fails" do
    allow(ActiveRecord::Base.connection).to receive(:select_value).and_raise("database unavailable")
    allow(Rails.error).to receive(:report)

    get "/ready"

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body.dig("components", "database")).to eq("unavailable")
    expect(response.parsed_body.dig("components", "opaqueByteStorage")).to eq("ready")
  end

  it "reports unavailable when opaque byte storage fails" do
    allow(Coordination::DiskStore).to receive(:root).and_raise("storage unavailable")
    allow(Rails.error).to receive(:report)

    get "/ready"

    expect(response).to have_http_status(:service_unavailable)
    expect(response.parsed_body).to eq(
      "status" => "unavailable",
      "components" => {
        "database" => "ready",
        "opaqueByteStorage" => "unavailable"
      }
    )
  end
end
