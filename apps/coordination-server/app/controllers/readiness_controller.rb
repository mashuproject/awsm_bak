class ReadinessController < ActionController::API
  COMPONENTS = {
    "database" => :database_ready?,
    "opaqueByteStorage" => :opaque_byte_storage_ready?,
    "ephemeralCoordination" => :ephemeral_coordination_ready?
  }.freeze
  private_constant :COMPONENTS

  def show
    components = COMPONENTS.to_h do |name, probe|
      [ name, probe_component(name, probe) ? "ready" : "unavailable" ]
    end
    critical_ready = components.values_at("database", "opaqueByteStorage").all?("ready")
    status = if !critical_ready
      "unavailable"
    elsif components["ephemeralCoordination"] == "unavailable"
      "degraded"
    else
      "ready"
    end

    render json: { status:, components: },
      status: critical_ready ? :ok : :service_unavailable
  end

  private

  def database_ready?
    ActiveRecord::Base.connection.select_value("SELECT 1")
    true
  end

  def opaque_byte_storage_ready?
    root = Coordination::DiskStore.root
    FileUtils.mkdir_p(root)
    probe = root.join(".readiness-#{Process.pid}")
    File.open(probe, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write("ready") }
    File.delete(probe)
    true
  ensure
    File.delete(probe) if defined?(probe) && probe && File.exist?(probe)
  end

  def ephemeral_coordination_ready?
    Coordination::EphemeralCoordination.ping == "PONG"
  end

  def probe_component(name, probe)
    send(probe)
  rescue StandardError => error
    reported_error = if name == "ephemeralCoordination"
      Coordination::EphemeralCoordination.unavailable_error
    else
      error
    end
    Rails.error.report(reported_error, handled: true,
      context: { component: "readiness", probe: name })
    false
  end
end
