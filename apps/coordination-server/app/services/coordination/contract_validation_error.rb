module Coordination
  class ContractValidationError < Committee::ValidationError
    def error_body
      request_id = valid_request_id
      {
        outcome: "protocol_invalid",
        retryable: false,
        request_id:,
        retry_after_seconds: nil
      }
    end

    def render
      request_id = valid_request_id
      headers = {
        "Content-Type" => "application/json",
        "Awsm-Protocol-Version" => "1",
        "Awsm-Request-ID" => request_id
      }
      [ status, headers, [ JSON.generate(error_body) ] ]
    end

    private

    def valid_request_id
      supplied = request.get_header("HTTP_AWSM_REQUEST_ID")
      return supplied if supplied&.match?(/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/)

      request.get_header("action_dispatch.request_id") || SecureRandom.uuid
    end
  end
end
