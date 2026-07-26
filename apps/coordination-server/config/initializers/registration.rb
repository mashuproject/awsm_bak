Rails.application.config.after_initialize do
  Coordination::Registration.validate_configuration!
end
