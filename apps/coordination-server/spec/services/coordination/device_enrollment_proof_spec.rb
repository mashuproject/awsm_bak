require "rails_helper"
require "digest"
require "openssl"

RSpec.describe Coordination::DeviceEnrollmentProof do
  let(:device_signing) { OpenSSL::PKey.generate_key("ED25519") }
  let(:account_session_id) { "01900000-0000-7000-8000-000000000016" }
  let(:certificate_cbor) { "canonical certificate bytes" }
  let(:certificate_signature) { "s" * 64 }
  let(:transcript) do
    Coordination::CanonicalCbor.encode(
      "domain" => "awsm:device-enrollment-proof:v1",
      "certificateSha256" => Digest::SHA256.digest(certificate_cbor),
      "certificateSignatureSha256" => Digest::SHA256.digest(certificate_signature),
      "accountSessionId" => account_session_id
    )
  end

  def encode(bytes)
    Base64.urlsafe_encode64(bytes, padding: false)
  end

  it "requires possession of the certified signing key for the current Account session" do
    proof = encode(device_signing.sign(nil, transcript))

    expect {
      described_class.verify!(
        proof,
        certificate_cbor:,
        certificate_signature:,
        signing_public_key: device_signing.raw_public_key,
        account_session_id:
      )
    }.not_to raise_error

    [
      [ encode("p" * 64), account_session_id ],
      [ proof, "01900000-0000-7000-8000-000000000099" ]
    ].each do |candidate, session_id|
      expect {
        described_class.verify!(
          candidate,
          certificate_cbor:,
          certificate_signature:,
          signing_public_key: device_signing.raw_public_key,
          account_session_id: session_id
        )
      }.to raise_error(Coordination::OutcomeError) { |error|
        expect(error.outcome).to eq("DEVICE_ENROLLMENT_INVALID")
      }
    end
  end
end
