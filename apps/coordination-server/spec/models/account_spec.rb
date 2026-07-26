require "rails_helper"

RSpec.describe Account, type: :model do
  let(:attributes) do
    {
      email: "reader@example.test",
      password: "correct horse battery staple",
      password_confirmation: "correct horse battery staple"
    }
  end

  it "stores one normalized password credential and permits at most one Vault" do
    account = described_class.create!(**attributes)

    expect(account.email).to eq("reader@example.test")
    expect(account.password_digest).to be_present
    expect(account.authenticate("correct horse battery staple")).to eq(account)
    expect(account.authenticate("wrong password")).to be(false)
    expect(account.vault_replicas).to be_empty
  end

  it "rejects duplicate normalized email" do
    described_class.create!(**attributes)

    duplicate = described_class.new(**attributes.merge(email: "READER@EXAMPLE.TEST"))

    expect(duplicate).not_to be_valid
    expect(duplicate.errors[:email]).to be_present
  end
end
