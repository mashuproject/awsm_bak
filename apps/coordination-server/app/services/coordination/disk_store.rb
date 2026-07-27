require "fileutils"
require "securerandom"
require "tempfile"

module Coordination
  module DiskStore
    module_function

    def root
      storage_root = Pathname(ENV.fetch("AWSM_OPAQUE_STORAGE_PATH", Rails.root.join("storage/opaque"))).expand_path
      raise ArgumentError, "symlink storage root" if File.symlink?(storage_root)

      FileUtils.mkdir_p(storage_root, mode: 0o700)
      File.chmod(0o700, storage_root)
      storage_root
    end

    def path(key)
      raise ArgumentError, "invalid storage key" if key.blank? || Pathname(key).absolute?

      candidate = root.join(key).cleanpath
      root_prefix = "#{root}/"
      raise ArgumentError, "invalid storage key" unless candidate.to_s.start_with?(root_prefix)

      reject_symlink_path!(candidate)
      candidate
    end

    def write_part(upload_id:, part_number:, io:)
      key = "parts/#{upload_id}/#{part_number}"
      destination = path(key)
      FileUtils.mkdir_p(destination.dirname, mode: 0o700)
      temporary = Tempfile.new([ "part-", ".tmp" ], destination.dirname, binmode: true)
      temporary.chmod(0o600)
      digest = Digest::SHA256.new
      length = 0
      while (chunk = io.read(1024 * 1024))
        temporary.write(chunk)
        digest.update(chunk)
        length += chunk.bytesize
      end
      yield length, digest.digest
      temporary.flush
      temporary.fsync
      temporary.close
      File.rename(temporary.path, destination)
      fsync_directory(destination.dirname)
      [ key, length, digest.digest ]
    ensure
      temporary&.close!
    end

    def install_object(record:, parts:)
      key = "objects/#{SecureRandom.hex(1)}/#{SecureRandom.hex(32)}"
      destination = path(key)
      FileUtils.mkdir_p(destination.dirname, mode: 0o700)
      temporary = Tempfile.new([ "object-", ".part" ], root, binmode: true)
      temporary.chmod(0o600)
      digest = Digest::SHA256.new
      length = 0
      parts.each do |part|
        File.open(path(part.storage_key), "rb") do |source|
          while (chunk = source.read(1024 * 1024))
            temporary.write(chunk)
            digest.update(chunk)
            length += chunk.bytesize
          end
        end
      end
      temporary.flush
      temporary.fsync
      yield length, digest.digest
      temporary.close
      File.rename(temporary.path, destination)
      fsync_directory(destination.dirname)
      key
    ensure
      temporary&.close!
    end

    def read_range(key, offset:, length:)
      source = path(key)
      raise Errno::ENOENT unless File.file?(source)

      Enumerator.new do |output|
        File.open(source, "rb") do |file|
          file.seek(offset)
          remaining = length
          while remaining.positive?
            chunk = file.read([ remaining, 1024 * 1024 ].min)
            break unless chunk
            output << chunk
            remaining -= chunk.bytesize
          end
        end
      end
    end

    def delete(key)
      target = path(key)
      return :already_missing unless File.exist?(target)

      File.delete(target)
      :deleted
    end

    def exists?(key)
      File.exist?(path(key))
    end

    def reject_symlink_path!(candidate)
      relative = candidate.relative_path_from(root)
      current = root
      relative.each_filename do |component|
        current_path = current.join(component)
        raise ArgumentError, "symlink storage path" if File.symlink?(current_path)
        current = current_path
      end
    end
    private_class_method :reject_symlink_path!

    def fsync_directory(directory)
      File.open(directory, "r") { |handle| handle.fsync }
    end
    private_class_method :fsync_directory
  end
end
