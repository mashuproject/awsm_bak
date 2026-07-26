class OpaqueRecord < ApplicationRecord
  TYPES = %w[Event BundleDescriptor Artifact VaultGeneration].freeze
  STATES = %w[Uploading DurableUncommitted Committed Purged].freeze

  belongs_to :vault_replica
  belongs_to :vault_key_epoch
  belongs_to :target_generation, class_name: "VaultGeneration", foreign_key: :target_generation_id,
    primary_key: :generation_id
  has_many :record_dependencies, foreign_key: :event_record_id, dependent: :destroy,
    inverse_of: :event_record
  has_many :dependency_records, through: :record_dependencies
  has_one :upload, dependent: :destroy
  has_many :generation_memberships, dependent: :restrict_with_exception

  validates :object_id, presence: true, uniqueness: true
  validates :object_type, inclusion: { in: TYPES }
  validates :state, inclusion: { in: STATES }
  validates :byte_length, numericality: { only_integer: true, greater_than: 0 }
  validate :event_metadata_matches_type

  private

  def event_metadata_matches_type
    valid = object_type == "Event" ? event_ordering_timestamp.present? : event_ordering_timestamp.nil?
    errors.add(:event_ordering_timestamp, "does not match Object type") unless valid
  end
end
