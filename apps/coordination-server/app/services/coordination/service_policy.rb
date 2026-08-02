module Coordination
  class ServicePolicy
    DEFAULTS = {
      inactive_account_retention_days: 365,
      upload_staging_expiry_hours: 24,
      upload_capability_lifetime_seconds: 900,
      maximum_upload_part_bytes: 8_388_608,
      maximum_upload_parts: 10_000,
      maximum_compact_payload_bytes: 16_777_216,
      maximum_streamable_payload_bytes: 9_007_199_254_736_883,
      maximum_inventory_page_size: 500
    }.freeze

    def self.current
      new(
        inactive_account_retention_days: integer(
          "AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS",
          1..36_500
        ),
        upload_staging_expiry_hours: integer("AWSM_UPLOAD_STAGING_EXPIRY_HOURS", 1..8_760),
        upload_capability_lifetime_seconds: integer(
          "AWSM_UPLOAD_CAPABILITY_LIFETIME_SECONDS",
          1..86_400
        ),
        maximum_upload_part_bytes: integer(
          "AWSM_MAXIMUM_UPLOAD_PART_BYTES",
          1..1_073_741_824
        ),
        maximum_upload_parts: integer("AWSM_MAXIMUM_UPLOAD_PARTS", 1..10_000),
        maximum_compact_payload_bytes: integer(
          "AWSM_MAXIMUM_COMPACT_PAYLOAD_BYTES",
          16..16_777_216
        ),
        maximum_streamable_payload_bytes: integer(
          "AWSM_MAXIMUM_STREAMABLE_PAYLOAD_BYTES",
          16..9_007_199_254_736_883
        ),
        maximum_inventory_page_size: integer(
          "AWSM_MAXIMUM_INVENTORY_PAGE_SIZE",
          1..500
        )
      )
    end

    def self.integer(name, range, key = name.delete_prefix("AWSM_").downcase.to_sym)
      value = Integer(ENV.fetch(name, DEFAULTS.fetch(key)).to_s, 10)
      raise "#{name} is outside its supported range" unless range.cover?(value)

      value
    rescue ArgumentError
      raise "#{name} must be an integer"
    end
    private_class_method :integer

    attr_reader(*DEFAULTS.keys)

    def initialize(**overrides)
      DEFAULTS.merge(overrides).each { |key, value| instance_variable_set("@#{key}", value) }
    end

    def as_json(*)
      {
        inactive_account_retention_days:,
        upload_staging_expiry_hours:,
        upload_capability_lifetime_seconds:,
        maximum_upload_part_bytes:,
        maximum_upload_parts:,
        maximum_compact_payload_bytes:,
        maximum_streamable_payload_bytes:,
        maximum_inventory_page_size:,
        range_reads: true,
        resumable_uploads: true,
        wake_hints: true
      }
    end
  end
end
