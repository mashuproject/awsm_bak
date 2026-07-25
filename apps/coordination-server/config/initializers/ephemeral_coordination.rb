Rails.application.config.after_initialize do
  unless Coordination::EphemeralCoordination.asset_precompilation?
    Coordination::EphemeralCoordination.validate_configuration!
  end
end
