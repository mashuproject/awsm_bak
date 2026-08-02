module Coordination
  class OutcomeError < StandardError
    attr_reader :outcome, :status, :retryable, :retry_after_seconds

    def initialize(outcome, status:, retryable: false, retry_after_seconds: nil)
      @outcome = outcome
      @status = status
      @retryable = retryable
      @retry_after_seconds = retry_after_seconds
      super(outcome)
    end
  end
end
