require "rails_helper"

RSpec.describe BrowserSession, type: :model do
  let(:account) do
    Account.create!(
      username: "quiet_vault",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple",
      last_activity_at: Time.current
    )
  end

  it "stores only a coarse client family and activity timestamps" do
    session = described_class.create!(
      channel_principal: account.channel_principal,
      client_family: "Firefox",
      last_activity_at: Time.current
    )

    expect(session.client_family).to eq("Firefox")
    expect(session.last_activity_at).to be_present
    expect(described_class.column_names).not_to include("ip_address", "user_agent")
  end

  it "accepts only the canonical coarse client families" do
    %w[Chrome Firefox Other].each do |client_family|
      expect(
        described_class.new(
          channel_principal: account.channel_principal,
          client_family:,
          last_activity_at: Time.current
        )
      ).to be_valid
    end

    expect(
      described_class.new(
        channel_principal: account.channel_principal,
        client_family: "Safari",
        last_activity_at: Time.current
      )
    ).not_to be_valid
  end

  it "enforces the coarse client family in PostgreSQL" do
    attributes = {
      channel_principal_id: account.channel_principal.id,
      client_family: "Safari",
      last_activity_at: Time.current,
      created_at: Time.current,
      updated_at: Time.current
    }

    expect { described_class.insert_all!([ attributes ]) }.to raise_error(
      ActiveRecord::StatementInvalid,
      /browser_sessions_client_family/
    )
  end
end
