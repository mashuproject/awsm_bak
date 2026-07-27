require "digest"
require "securerandom"

module Coordination
  class TransferTicketIssuer
    def self.upload(account:, vault:, upload:)
      account.with_lock do
        unless account.active?
          raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
        end
        token = SecureRandom.urlsafe_base64(32, padding: false)
        expires_at = ServicePolicy.current.transfer_ticket_lifetime_seconds.seconds.from_now
        TransferTicket.create!(
          account:, vault_replica: vault, upload:,
          token_sha256: Digest::SHA256.digest(token), purpose: "UploadPart", expires_at:
        )
        {
          method: "PUT", url: "/api/transfers/#{token}/parts/{partNumber}",
          urlTemplate: "/api/transfers/#{token}/parts/{partNumber}",
          expiresAt: ProtocolEncoding.timestamp(expires_at),
          requiredHeaders: {
            "Content-Type" => "application/octet-stream",
            "Content-Length" => "<part-byte-length>",
            "Content-SHA256" => "<unpadded-base64url-sha256>"
          }
        }
      end
    end

    def self.download(account:, vault:, record:, generation:, purpose: "ActiveDownload")
      account.with_lock do
        unless account.active?
          raise OutcomeError.new("AUTHENTICATION_FAILED", status: :unauthorized)
        end
        token = SecureRandom.urlsafe_base64(32, padding: false)
        expires_at = ServicePolicy.current.transfer_ticket_lifetime_seconds.seconds.from_now
        TransferTicket.create!(
          account:, vault_replica: vault, opaque_record: record,
          vault_generation: generation, token_sha256: Digest::SHA256.digest(token),
          purpose:, expires_at:
        )
        {
          method: "GET", url: "/api/transfers/#{token}",
          expiresAt: ProtocolEncoding.timestamp(expires_at), requiredHeaders: {}
        }
      end
    end
  end
end
