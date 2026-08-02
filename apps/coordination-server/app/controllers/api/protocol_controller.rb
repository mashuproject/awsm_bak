module Api
  class ProtocolController < ActionController::API
    before_action :validate_request_id
    before_action :validate_protocol

    rescue_from Coordination::OutcomeError, with: :render_outcome
    rescue_from ActiveRecord::RecordInvalid, with: :render_invalid

    private

    def validate_request_id
      value = request.headers["Awsm-Request-ID"]
      unless value&.match?(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/)
        raise Coordination::OutcomeError.new("protocol_invalid", status: :bad_request)
      end
      response.set_header("Awsm-Request-ID", value)
    end

    def validate_protocol
      response.set_header("Awsm-Protocol-Version", "1")
      return if request.headers["Awsm-Protocol-Version"] == "1"
      raise Coordination::OutcomeError.new("protocol_invalid", status: :bad_request)
    end

    def render_outcome(error)
      request_id = protocol_request_id
      response.set_header("Awsm-Protocol-Version", "1")
      response.set_header("Awsm-Request-ID", request_id)
      payload = {
        outcome: error.outcome,
        retryable: error.retryable,
        request_id:,
        retry_after_seconds: error.retry_after_seconds
      }
      render json: payload, status: error.status
    end

    def render_invalid(_error)
      render_outcome(Coordination::OutcomeError.new("protocol_invalid", status: :bad_request))
    end

    def protocol_request_id
      value = request.headers["Awsm-Request-ID"]
      return value if value&.match?(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/)

      request.request_id
    end
  end
end
