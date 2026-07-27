require "digest"

module Api
  class TransfersController < BaseController
    skip_before_action :authenticate_account
    skip_before_action :require_vault_device_scope

    def put_part
      ticket = upload_ticket!
      with_active_ticket_account(ticket) do
        upload = ticket.upload
        validate_open!(upload)
        part_number = Integer(params[:part_number], 10)
        expected_length = expected_part_length(upload, part_number)
        advertised_length = Integer(request.headers["Content-Length"], 10)
        advertised_sha = Coordination::ProtocolEncoding.decode_sha256(
          request.headers["Content-SHA256"]
        )
        unless advertised_length == expected_length
          raise Coordination::OutcomeError.new(
            "OBJECT_LENGTH_MISMATCH", status: :unprocessable_content
          )
        end

        existing = upload.upload_parts.find_by(part_number:)
        if existing
          matching = existing.byte_length == expected_length &&
            ActiveSupport::SecurityUtils.secure_compare(existing.sha256, advertised_sha)
          unless matching
            raise Coordination::OutcomeError.new("UPLOAD_PART_CONFLICT", status: :conflict)
          end
          next head :no_content
        end

        key, actual_length, actual_sha = Coordination::DiskStore.write_part(
          upload_id: upload.id, part_number:, io: request.body
        ) do |length, sha256|
          unless length == expected_length
            raise Coordination::OutcomeError.new(
              "OBJECT_LENGTH_MISMATCH", status: :unprocessable_content
            )
          end
          unless ActiveSupport::SecurityUtils.secure_compare(advertised_sha, sha256)
            raise Coordination::OutcomeError.new(
              "OBJECT_CHECKSUM_MISMATCH", status: :unprocessable_content
            )
          end
        end
        upload.upload_parts.create!(
          part_number:, byte_length: actual_length, sha256: actual_sha,
          storage_key: key, received_at: Time.current
        )
        upload.update!(last_activity_at: Time.current)
        head :no_content
      end
    rescue ArgumentError, TypeError
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :bad_request)
    end

    def show
      ticket = download_ticket!
      with_active_ticket_account(ticket) do
        record = ticket.opaque_record
        source_path = Coordination::DiskStore.path(record.storage_key)
        unless record.state == "Committed" && File.file?(source_path)
          raise Coordination::OutcomeError.new(
            "STORAGE_UNAVAILABLE", status: :service_unavailable, retryable: true
          )
        end
        start_byte, end_byte = byte_range(record.byte_length)
        length = end_byte - start_byte + 1
        response.set_header("Accept-Ranges", "bytes")
        response.set_header("Content-Length", length.to_s)
        response.set_header(
          "ETag", %("#{Coordination::ProtocolEncoding.encode_sha256(record.sha256)}")
        )
        if request.headers["Range"].present?
          response.set_header(
            "Content-Range", "bytes #{start_byte}-#{end_byte}/#{record.byte_length}"
          )
        end
        response.status = request.headers["Range"].present? ? :partial_content : :ok
        response.content_type = "application/octet-stream"
        self.response_body = Coordination::DiskStore.read_range(
          record.storage_key, offset: start_byte, length:
        )
      end
    end

    private

    def upload_ticket!
      token_sha256 = Digest::SHA256.digest(params[:ticket].to_s)
      ticket = TransferTicket.find_by(token_sha256:, purpose: "UploadPart", revoked_at: nil)
      unless ticket && ticket.expires_at.future?
        raise Coordination::OutcomeError.new("TRANSFER_TICKET_INVALID", status: :not_found)
      end
      ticket
    end

    def download_ticket!
      token_sha256 = Digest::SHA256.digest(params[:ticket].to_s)
      ticket = TransferTicket.where(purpose: [ "ActiveDownload", "RecoveryDownload" ],
        revoked_at: nil).find_by(token_sha256:)
      unless ticket && ticket.expires_at.future?
        raise Coordination::OutcomeError.new("TRANSFER_TICKET_INVALID", status: :not_found)
      end
      ticket
    end

    def with_active_ticket_account(ticket)
      ticket.account.with_lock do
        unless ticket.account.active?
          raise Coordination::OutcomeError.new("TRANSFER_TICKET_INVALID", status: :not_found)
        end
        Coordination::AccountActivity.touch!(account: ticket.account)
        yield
      end
    end

    def byte_range(total)
      value = request.headers["Range"]
      return [ 0, total - 1 ] if value.blank?
      match = /\Abytes=(\d*)-(\d*)\z/.match(value)
      raise_invalid_range unless match && !(match[1].empty? && match[2].empty?)
      if match[1].empty?
        length = Integer(match[2], 10)
        raise_invalid_range unless length.positive?
        [ total - [ length, total ].min, total - 1 ]
      else
        first = Integer(match[1], 10)
        last = match[2].empty? ? total - 1 : Integer(match[2], 10)
        raise_invalid_range unless first < total && last >= first
        [ first, [ last, total - 1 ].min ]
      end
    end

    def raise_invalid_range
      raise Coordination::OutcomeError.new("REQUEST_INVALID", status: :range_not_satisfiable)
    end

    def validate_open!(upload)
      if upload.expires_at.past? || upload.state == "Expired"
        raise Coordination::OutcomeError.new("UPLOAD_EXPIRED", status: :gone)
      end
      return if upload.state == "Open"

      raise Coordination::OutcomeError.new("OBJECT_NOT_DURABLE", status: :conflict)
    end

    def expected_part_length(upload, part_number)
      raise ArgumentError unless part_number.between?(0, upload.part_count - 1)
      return upload.part_size unless part_number == upload.part_count - 1

      upload.opaque_record.byte_length - (upload.part_size * (upload.part_count - 1))
    end
  end
end
