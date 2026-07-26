require "uri"

module Coordination
  module Registration
    module_function

    def enabled?
      parse_enabled(ENV["AWSM_ACCOUNT_REGISTRATION_ENABLED"])
    end

    def sign_up_url
      return unless enabled?

      "#{public_origin}/sign_up"
    end

    def validate_configuration!
      enabled?
      public_origin
      true
    end

    def public_origin
      value = ENV["AWSM_PUBLIC_ORIGIN"].presence || default_public_origin
      uri = URI.parse(value)
      valid_scheme = uri.scheme == "https" ||
        (!Rails.env.production? && uri.scheme == "http")
      valid = valid_scheme && uri.host.present? && uri.userinfo.nil? &&
        (uri.path.blank? || uri.path == "/") && uri.query.nil? && uri.fragment.nil?
      raise ArgumentError, "AWSM_PUBLIC_ORIGIN is invalid" unless valid

      value.delete_suffix("/")
    rescue URI::InvalidURIError
      raise ArgumentError, "AWSM_PUBLIC_ORIGIN is invalid"
    end

    def parse_enabled(value)
      return !Rails.env.production? if value.blank?
      return true if value.casecmp?("true")
      return false if value.casecmp?("false")

      raise ArgumentError, "AWSM_ACCOUNT_REGISTRATION_ENABLED is invalid"
    end
    private_class_method :parse_enabled

    def default_public_origin
      return "http://www.example.com" if Rails.env.test?
      return "http://localhost:3000" if Rails.env.development?

      raise ArgumentError, "AWSM_PUBLIC_ORIGIN is required"
    end
    private_class_method :default_public_origin
  end
end
