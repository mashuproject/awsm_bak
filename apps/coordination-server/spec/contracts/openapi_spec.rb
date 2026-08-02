require "rails_helper"
require "yaml"

RSpec.describe "Coordination HTTP contract" do
  Given(:contract_path) { Rails.root.join("../../docs/specifications/protocol/http-api.openapi.yaml") }

  context "when loading the canonical OpenAPI document" do
    When(:document) { YAML.safe_load_file(contract_path) }

    Then { document.fetch("openapi") == "3.0.3" }
    And { document.dig("info", "version") == "1" }
    And { document.fetch("paths").key?("/api/service-policy") }
    And { document.fetch("paths").key?("/api/replicas") }
    And do
      expected_paths = %w[
        /api/replicas/{replica_handle}/hint
        /api/replicas/{replica_handle}/inventory
        /api/replicas/{replica_handle}/items/{storage_item_id}
        /api/replicas/{replica_handle}/uploads
        /api/replicas/{replica_handle}/uploads/{upload_handle}/capability
        /api/uploads/{upload_handle}
        /api/uploads/{upload_handle}/finalize
      ]
      (expected_paths - document.fetch("paths").keys).empty?
    end
    And do
      document.dig("components", "schemas", "HostedReplicaSummary", "additionalProperties") == false
    end
    And do
      serialized = document.to_yaml
      serialized.exclude?("VaultDevice") && serialized.exclude?("Generation") &&
        serialized.exclude?("/api/vaults")
    end
  end
end
