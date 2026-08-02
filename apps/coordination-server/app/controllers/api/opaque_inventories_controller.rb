module Api
  class OpaqueInventoriesController < BaseController
    def show
      grant = current_replica_grant!(params[:hosted_replica_id], "awsm.replica.inventory.read")
      replica = grant.hosted_replica
      snapshot_cursor = integer_parameter(:snapshot_cursor, default: replica.inventory_cursor)
      limit = integer_parameter(:limit, default: 100)
      policy = Coordination::ServicePolicy.current
      unless snapshot_cursor.between?(0, replica.inventory_cursor) &&
          limit.between?(1, policy.maximum_inventory_page_size)
        raise Coordination::OutcomeError.new("cursor_invalid", status: :bad_request)
      end

      items = replica.opaque_storage_items.where(inventory_cursor: ..snapshot_cursor)
      if params[:position].present?
        position = Coordination::ProtocolEncoding.decode_sha256(params[:position])
        unless items.exists?(storage_item_id: position)
          raise Coordination::OutcomeError.new("cursor_invalid", status: :bad_request)
        end
        items = items.where(OpaqueStorageItem.arel_table[:storage_item_id].gt(position))
      end
      page = items.order(:storage_item_id).limit(limit + 1).to_a
      more = page.length > limit
      page = page.first(limit)
      render json: {
        snapshot_cursor:,
        next_position: more ? encoded_id(page.last.storage_item_id) : nil,
        items: page.map { |item| serialize(item) }
      }
    rescue ArgumentError
      raise Coordination::OutcomeError.new("cursor_invalid", status: :bad_request)
    end

    private

    def integer_parameter(name, default:)
      value = params[name]
      value.nil? ? default : Integer(value, 10)
    end

    def serialize(item)
      {
        storage_item_id: encoded_id(item.storage_item_id),
        storage_class: item.storage_class.downcase,
        byte_length: item.byte_length,
        ciphertext_digest: encoded_id(item.ciphertext_digest)
      }
    end

    def encoded_id(value)
      Coordination::ProtocolEncoding.encode_sha256(value)
    end
  end
end
