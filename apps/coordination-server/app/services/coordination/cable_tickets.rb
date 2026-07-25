require "securerandom"

module Coordination
  module CableTickets
    module_function

    LIFETIME = 60.seconds
    ATTEMPTS = 3
    TICKET_PATTERN = /\A[A-Za-z0-9_-]{43}\z/
    ACCOUNT_ID_PATTERN =
      /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/
    private_constant :ATTEMPTS, :TICKET_PATTERN, :ACCOUNT_ID_PATTERN

    class CollisionBudgetExhausted < StandardError
      def initialize
        super("ticket_collision_budget_exhausted")
      end
    end
    private_constant :CollisionBudgetExhausted

    def issue(account)
      ATTEMPTS.times do
        raw_ticket = ProtocolEncoding.encode_base64url(SecureRandom.random_bytes(32))
        stored = EphemeralCoordination.with_redis do |redis|
          redis.set(EphemeralCoordination.ticket_key(raw_ticket), account.id, nx: true, ex: 60)
        end
        return [ raw_ticket, LIFETIME.from_now ] if stored
      end

      error = CollisionBudgetExhausted.new
      report(error, operation: "issue")
      raise OutcomeError.new("AUTHENTICATION_UNAVAILABLE",
        status: :service_unavailable, retryable: true)
    rescue Redis::BaseError
      report(EphemeralCoordination.unavailable_error, operation: "issue")
      raise OutcomeError.new("AUTHENTICATION_UNAVAILABLE",
        status: :service_unavailable, retryable: true)
    end

    def consume(raw_ticket)
      ticket = raw_ticket.to_s
      invalid! unless TICKET_PATTERN.match?(ticket)
      decoded = ProtocolEncoding.decode_base64url(ticket, bytes: 32)
      invalid! unless ProtocolEncoding.encode_base64url(decoded) == ticket

      account_id = EphemeralCoordination.with_redis do |redis|
        redis.getdel(EphemeralCoordination.ticket_key(ticket))
      end
      invalid! unless account_id&.match?(ACCOUNT_ID_PATTERN)

      Account.find_by(id: account_id) || invalid!
    rescue ArgumentError
      invalid!
    rescue Redis::BaseError
      report(EphemeralCoordination.unavailable_error, operation: "consume")
      raise OutcomeError.new("AUTHENTICATION_UNAVAILABLE",
        status: :service_unavailable, retryable: true)
    end

    def invalid!
      raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
    end
    private_class_method :invalid!

    def report(error, operation:)
      Rails.error.report(error, handled: true,
        context: { component: "ephemeral_coordination", operation: })
    end
    private_class_method :report
  end
end
