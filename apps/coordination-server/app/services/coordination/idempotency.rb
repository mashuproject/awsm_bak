require "digest"

module Coordination
  class Idempotency
    def initialize(account:, request:, operation:)
      @account = account
      @request = request
      @operation = operation
    end

    def replay
      record = existing
      return unless record

      conflict! unless ActiveSupport::SecurityUtils.secure_compare(record.request_sha256, request_sha256)
      record
    end

    def persist!(resource_type:, resource_id:)
      IdempotencyRecord.create!(account: @account, idempotency_key: key, operation: @operation,
        http_method: @request.request_method, canonical_path: @request.path,
        request_sha256:, status: "Succeeded", resource_type:, resource_id:)
    rescue ActiveRecord::RecordNotUnique
      replay || conflict!
    end

    private

    def existing
      IdempotencyRecord.find_by(account: @account, operation: @operation, idempotency_key: key)
    end

    def key
      @key ||= begin
        value = @request.headers["Idempotency-Key"]
        unless value&.match?(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/)
          raise OutcomeError.new("protocol_invalid", status: :bad_request)
        end
        value
      end
    end

    def request_sha256
      @request_sha256 ||= Digest::SHA256.digest(
        [ @request.request_method, @request.path, @request.raw_post ].join("\0")
      )
    end

    def conflict!
      raise OutcomeError.new("request_conflict", status: :conflict)
    end
  end
end
