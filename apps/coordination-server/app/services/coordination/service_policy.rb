module Coordination
  class ServicePolicy
    DEFAULTS = {
      inactive_account_retention_days: 365,
      recovery_retention_days: 90,
      upload_staging_expiry_hours: 24,
      transfer_ticket_lifetime_seconds: 900,
      upload_part_size_bytes: 8_388_608,
      maximum_upload_parts: 10_000,
      maximum_object_byte_length: 9_007_199_254_740_991,
      maximum_changes_page_size: 500,
      maximum_record_page_size: 500
    }.freeze

    def self.current
      new(
        inactive_account_retention_days: integer(
          "AWSM_INACTIVE_ACCOUNT_RETENTION_DAYS",
          1..36_500
        ),
        recovery_retention_days: integer("AWSM_RECOVERY_RETENTION_DAYS", 0..36_500),
        upload_staging_expiry_hours: integer("AWSM_UPLOAD_STAGING_EXPIRY_HOURS", 1..8_760),
        transfer_ticket_lifetime_seconds: integer("AWSM_TRANSFER_TICKET_LIFETIME_SECONDS", 1..86_400),
        upload_part_size_bytes: integer("AWSM_UPLOAD_PART_SIZE_BYTES", 1..1_073_741_824),
        maximum_upload_parts: integer("AWSM_MAX_UPLOAD_PARTS", 1..10_000, :maximum_upload_parts)
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
        inactiveAccountRetentionDays: inactive_account_retention_days,
        recoveryRetentionDays: recovery_retention_days,
        uploadStagingExpiryHours: upload_staging_expiry_hours,
        transferTicketLifetimeSeconds: transfer_ticket_lifetime_seconds,
        uploadPartSizeBytes: upload_part_size_bytes,
        maximumUploadParts: maximum_upload_parts,
        maximumObjectByteLength: maximum_object_byte_length,
        maximumChangesPageSize: maximum_changes_page_size,
        maximumRecordPageSize: maximum_record_page_size,
        notifications: { actionCable: true }
      }
    end
  end
end
