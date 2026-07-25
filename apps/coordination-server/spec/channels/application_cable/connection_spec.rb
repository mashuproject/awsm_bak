require "rails_helper"
require "rack/mock"

RSpec.describe ApplicationCable::Connection do
  it "consumes a one-use ticket and erases it from every retained request URL surface" do
    account = create_account
    raw_ticket, = Coordination::CableTickets.issue(account)
    request = ActionDispatch::Request.new(Rack::MockRequest.env_for("/cable?ticket=#{raw_ticket}"))
    connection = described_class.allocate
    allow(connection).to receive(:request).and_return(request)
    allow(connection).to receive(:current_account=)

    connection.connect

    expect(connection).to have_received(:current_account=).with(account)
    expect(request.params).not_to have_key("ticket")
    expect(request.original_url).not_to include(raw_ticket)
    expect(request.env.inspect).not_to include(raw_ticket)
    expect { Coordination::CableTickets.consume(raw_ticket) }
      .to raise_error(Coordination::OutcomeError, /AUTHENTICATION_FAILED/)
  end

  it "rejects an unavailable Redis connection and scrubs every retained URL surface" do
    raw_ticket = "a" * 43
    request = ActionDispatch::Request.new(Rack::MockRequest.env_for("/cable?ticket=#{raw_ticket}"))
    connection = described_class.allocate
    allow(connection).to receive(:request).and_return(request)
    allow(connection).to receive(:reject_unauthorized_connection)
    allow(Coordination::EphemeralCoordination).to receive(:with_redis)
      .and_raise(Redis::CannotConnectError, "credential-sentinel")
    allow(Rails.error).to receive(:report)

    connection.connect

    expect(connection).to have_received(:reject_unauthorized_connection)
    expect(request.params).not_to have_key("ticket")
    expect(request.original_url).not_to include(raw_ticket)
    expect(request.env.inspect).not_to include(raw_ticket)
  end
end
