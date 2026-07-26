module Api
  class CableTicketsController < BaseController
    def create
      raw_ticket, expires_at = Coordination::CableTickets.issue(current_principal)
      render json: {
        ticket: raw_ticket,
        expiresAt: Coordination::ProtocolEncoding.timestamp(expires_at)
      }, status: :created
    end
  end
end
