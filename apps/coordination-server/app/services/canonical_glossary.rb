class CanonicalGlossary
  Section = Data.define(:title, :terms)
  Term = Data.define(:title, :anchor, :summary)

  PUBLIC_SECTIONS = {
    "Your archive and access" => {
      "Account" => "Your login at one server. It lets you use that server. It does not open your Vault.",
      "Capture" => "A saved copy of a web page at one time.",
      "Client Credential" => "A key in a client installation. It lets that installation sign changes for a Vault member.",
      "Client Installation" => "One place where AWSM runs, such as one browser profile or desktop app.",
      "Complete Export" => "A file you keep yourself. It has what you need to rebuild a Vault. AWSM does not sync it.",
      "Recovery Phrase" => "Twelve private words. They help you get access to your Vault on a new client.",
      "Vault" => "Your encrypted archive. It keeps the saved data and history that belong together.",
      "Vault ID" => "The permanent random ID for a Vault. A host that stores encrypted data only does not receive it.",
      "Vault Member" => "A person or identity that has access to one Vault."
    },
    "Copies and synchronization" => {
      "Coordination Server" => "A server that helps copies of a Vault exchange encrypted data. It cannot read that data.",
      "Hosted Replica" => "A replica that a host stores for you. It can help you sync. It is not your only copy.",
      "Replica" => "One stored copy of a Vault. Copies can be complete or partial.",
      "Replica Access Grant" => "Permission from one replica host to use a hosted replica.",
      "Replica Host" => "A service or app that stores a replica and controls connections to it.",
      "Storage Relief" => "Removing local data to save space. Do this only when another replica keeps the data.",
      "Synchronization Cycle" => "One check and exchange of new encrypted data between replicas."
    },
    "Saved items" => {
      "Folder" => "A place that puts captures and other folders in an order.",
      "Library" => "The AWSM view where you find and manage saved captures.",
      "Note" => "Your written text attached to a capture.",
      "Tag" => "A label you add to a capture to help find it."
    }
  }.freeze

  def self.load
    source_titles = source_term_titles

    PUBLIC_SECTIONS.map do |section_title, summaries|
      terms = summaries.sort_by { |title, _summary| title.downcase }.map do |title, summary|
        raise "The canonical architecture glossary does not define #{title}." unless source_titles.include?(title)

        Term.new(title:, anchor: title.parameterize, summary:)
      end

      Section.new(title: section_title, terms:)
    end
  end

  def self.source_term_titles
    source_path.readlines(chomp: true).filter_map { |line| line[/^## (.+)$/, 1] }
  end

  def self.source_path
    [
      Pathname.new("/docs/architecture/glossary.md"),
      Rails.root.join("../../docs/architecture/glossary.md").expand_path
    ].find(&:file?) || raise("The canonical architecture glossary is unavailable.")
  end
end
