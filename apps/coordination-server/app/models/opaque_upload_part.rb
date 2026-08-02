class OpaqueUploadPart < ApplicationRecord
  belongs_to :opaque_upload

  validates :part_number, :start_offset,
    numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :byte_length, numericality: { only_integer: true, greater_than: 0 }
  validates :sha256, length: { is: 32 }
  validates :storage_key, presence: true, uniqueness: true
  validates :part_number, :start_offset, uniqueness: { scope: :opaque_upload_id }
end
