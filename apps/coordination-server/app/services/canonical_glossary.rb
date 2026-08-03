class CanonicalGlossary
  Section = Data.define(:title, :terms)
  Term = Data.define(:title, :anchor, :summary, :linked_titles)

  PUBLIC_SECTIONS = {
    "How AWSM works" => {
      "Client" => "Trusted software that opens, checks, and changes a local Vault copy.",
      "Local-First" => "Your Client keeps the usable data. Safe local work continues without a network connection.",
      "Server-Visible Metadata" => "A remote Replica Host can see some operating details, such as timing, sizes, and network data. It cannot see your saved content.",
      "Zero-Knowledge Synchronization" => "Your Client encrypts data before a remote Replica Host stores or transfers it. The Host does not have the keys or plaintext."
    },
    "Your archive and access" => {
      "Account" => "Your login at one Replica Host. It lets you use that Host. It does not open your Vault.",
      "Capture" => "A saved copy of a web page at one time. It belongs to your Vault.",
      "Client Credential" => "A key held by a Client Installation. It lets that installation sign changes for a Vault Member.",
      "Client Installation" => "One place where AWSM runs, such as one browser profile or desktop app.",
      "Complete Export" => "A file you keep yourself. It has what you need to rebuild a Vault. AWSM does not sync it.",
      "Recovery Phrase" => "Twelve private words. They help you get access to your Vault on a new Client Installation.",
      "Vault" => "Your encrypted archive. Local-First keeps it usable on your Client. A Replica is one stored copy of it.",
      "Vault ID" => "The permanent random ID for a Vault. A Replica Host that stores encrypted data only does not receive it.",
      "Vault Member" => "A person or identity that has access to one Vault."
    },
    "Copies and synchronization" => {
      "Coordination Server" => "A server that helps Replicas exchange encrypted data through Zero-Knowledge Synchronization. It cannot read that data.",
      "Hosted Replica" => "A Replica that a Host stores for you. It can help you sync. It is not your only copy.",
      "Replica" => "One stored copy of a Vault. Copies can be complete or partial.",
      "Replica Access Grant" => "Permission from one Replica Host to use a Hosted Replica.",
      "Replica Host" => "A service or app that stores a Replica and controls connections to it.",
      "Storage Relief" => "Removing local data to save space. Do this only when another Replica keeps the data.",
      "Synchronization Cycle" => "One check and exchange of new encrypted data between Replicas."
    },
    "Saved items" => {
      "Folder" => "A place that puts Captures and other folders in an order.",
      "Library" => "The AWSM view where you find and manage saved Captures.",
      "Note" => "Your written text attached to a Capture.",
      "Tag" => "A label you add to a Capture to help find it."
    }
  }.freeze

  def self.load
    source_titles = source_term_titles
    public_titles = PUBLIC_SECTIONS.values.flat_map(&:keys)

    PUBLIC_SECTIONS.map do |section_title, summaries|
      terms = summaries.sort_by { |title, _summary| title.downcase }.map do |title, summary|
        raise "The canonical architecture glossary does not define #{title}." unless source_titles.include?(title)

        linked_titles = public_titles.select { |candidate| candidate != title && summary.include?(candidate) }
        Term.new(title:, anchor: title.parameterize, summary:, linked_titles:)
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
