class ComparisonCatalog
  Category = Data.define(:title, :description)
  MatrixRow = Data.define(:label, :alternative, :awsm)
  EssaySection = Data.define(:title, :body)
  Source = Data.define(:label, :url)
  Comparison = Data.define(
    :slug,
    :name,
    :category,
    :badge,
    :title,
    :description,
    :official_url,
    :alternative_intro,
    :awsm_intro,
    :alternative_strengths,
    :awsm_strengths,
    :matrix,
    :essay,
    :sources,
    :reviewed_on
  )

  CATEGORIES = [
    Category.new(
      title: "Public web history",
      description: "Find and reference pages preserved as part of the public web record."
    ),
    Category.new(
      title: "Self-hosted archives",
      description: "Run an archive under your own infrastructure and choose its automation."
    ),
    Category.new(
      title: "Browser capture",
      description: "Save a page as a portable file from the browser in one focused action."
    ),
    Category.new(
      title: "Read later",
      description: "Save articles and return to them in a calmer reading workflow."
    ),
    Category.new(
      title: "Bookmark management",
      description: "Organize, search, and rediscover a growing collection of links."
    )
  ].freeze

  COMPARISONS = [
    Comparison.new(
      slug: "wayback-machine",
      name: "Wayback Machine",
      category: "Public web history",
      badge: "Public web history",
      title: "AWSM and the Wayback Machine: two ways to keep web history",
      description: "Choose between a public record of the web and a private archive that stays with you.",
      official_url: "https://web.archive.org/",
      alternative_intro: "The Wayback Machine is a public web archive built for finding and citing earlier versions of URLs.",
      awsm_intro: "AWSM is a personal archive: you capture pages from your browser and keep the encrypted Vault locally.",
      alternative_strengths: [
        "Search public captures by URL, site, or date.",
        "Reference a stable archived URL in research and publishing.",
        "Benefit from a large public collection gathered over time."
      ],
      awsm_strengths: [
        "Capture a page for yourself, including material that should not enter a public archive.",
        "Keep local access when the network or the original page is unavailable.",
        "Add optional encrypted synchronization without giving a Host the Vault keys."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Public web history and reference", awsm: "Personal web archive"),
        MatrixRow.new(label: "Who chooses the capture", alternative: "Internet Archive crawlers or a Save Page Now request", awsm: "The person using the trusted Client"),
        MatrixRow.new(label: "Privacy boundary", alternative: "A public archive service and its access policies", awsm: "Encrypted local Vault; optional Host stores opaque bytes"),
        MatrixRow.new(label: "Offline access", alternative: "Requires access to the Wayback service", awsm: "Local Captures remain usable without a network"),
        MatrixRow.new(label: "Best discovery tool", alternative: "URL history, dates, and public references", awsm: "Your local Library and Vault organization"),
        MatrixRow.new(label: "Capture scope", alternative: "Publicly reachable pages and permitted captures", awsm: "The active HTTP(S) page selected in your browser"),
        MatrixRow.new(label: "Account needed", alternative: "Not for ordinary public browsing", awsm: "No Account for local use; one is needed only for a chosen Host"),
        MatrixRow.new(label: "Current tradeoff", alternative: "A public service cannot guarantee every page or complete replay", awsm: "The current preview is a browser extension, not a public archive or web reader")
      ],
      essay: [
        EssaySection.new(
          title: "Choose the Wayback Machine for public memory",
          body: "The Wayback Machine is the right tool when your question is about the public web: what did this site look like, when was a page available, or how can I cite an older version? Its URL and date history is a major strength, and its public nature makes a captured page easy to reference with other people."
        ),
        EssaySection.new(
          title: "Choose AWSM for a personal archive",
          body: "AWSM starts with a different boundary. A Capture is made by your browser and belongs to your encrypted Vault. Local use does not require an Account or a server. That makes AWSM a better fit for private research, account-only material, personal records, and pages you want available on your own device rather than submitted to a public archive."
        ),
        EssaySection.new(
          title: "They solve different preservation problems",
          body: "The Wayback Machine is a public memory service. AWSM is a private archive that you can later synchronize through opaque Replicas. AWSM does not promise the scale, public search, or citation ecosystem of the Wayback Machine, and the Wayback Machine is not a replacement for an encrypted local Vault."
        )
      ],
      sources: [
        Source.new(label: "Using the Wayback Machine", url: "https://archivesupport.zendesk.com/hc/en-us/articles/360004651732-Using-The-Wayback-Machine"),
        Source.new(label: "Wayback Machine general information", url: "https://archivesupport.zendesk.com/hc/en-us/articles/360004716091-Wayback-Machine-General-Information")
      ],
      reviewed_on: "4 August 2026"
    ),
    Comparison.new(
      slug: "archivebox",
      name: "ArchiveBox",
      category: "Self-hosted archives",
      badge: "Self-hosted archive",
      title: "AWSM and ArchiveBox: personal Vault or archive system?",
      description: "Compare a browser-first encrypted Vault with a powerful self-hosted archiving system.",
      official_url: "https://archivebox.io/",
      alternative_intro: "ArchiveBox is a self-hosted archive system designed to ingest sources, automate captures, and produce many durable formats.",
      awsm_intro: "AWSM is a local-first browser Client that makes one trusted Capture part of an encrypted, recoverable Vault.",
      alternative_strengths: [
        "Import URLs, feeds, bookmark exports, and other sources.",
        "Produce HTML, screenshots, PDFs, WARC files, media, metadata, and more.",
        "Use a Web UI, CLI, APIs, SQLite, and ordinary files on disk."
      ],
      awsm_strengths: [
        "Capture the page you are actively viewing before sending anything to a Host.",
        "Keep the archive usable locally without operating a server.",
        "Use Recovery Phrase access and optional encrypted Replica synchronization."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Automated, self-hosted web archiving", awsm: "Personal browser-first archiving"),
        MatrixRow.new(label: "Inputs", alternative: "URLs, feeds, bookmark exports, APIs, and scheduled jobs", awsm: "An active HTTP(S) page in the trusted browser"),
        MatrixRow.new(label: "Outputs", alternative: "Many ordinary files and formats per snapshot", awsm: "A canonical page snapshot with screenshot, text, and structured derivatives"),
        MatrixRow.new(label: "Storage model", alternative: "A server-managed collection on local or remote storage", awsm: "Encrypted browser-local Vault with optional Hosted Replicas"),
        MatrixRow.new(label: "Automation", alternative: "CLI, API, schedules, importers, and extractor pipeline", awsm: "Explicit browser Capture; broader automation is not shipped in this preview"),
        MatrixRow.new(label: "Offline access", alternative: "Browse the collection from its files or local server", awsm: "Local Captures remain available without a network"),
        MatrixRow.new(label: "Privacy boundary", alternative: "You operate the server and define its access policy", awsm: "The Client holds Vault keys; a Host receives opaque encrypted items"),
        MatrixRow.new(label: "Best fit", alternative: "A researcher, operator, or team building an archive pipeline", awsm: "Someone who wants a private archive without making a server the primary application")
      ],
      essay: [
        EssaySection.new(
          title: "Choose ArchiveBox for archive operations",
          body: "ArchiveBox is a strong choice when the archive itself is an operational system. It can ingest many sources, run scheduled work, expose APIs, and retain several standard representations of a page. Its ordinary files, SQLite index, and broad extractor ecosystem are valuable when you need to process a collection at scale."
        ),
        EssaySection.new(
          title: "Choose AWSM for capture at the point of use",
          body: "AWSM puts the trusted browser at the center. You capture the page you are looking at, the Client validates the resulting Bundle, and the encrypted Vault remains useful without a Coordination Server. Optional synchronization is a channel for encrypted data, not a second web archive that becomes the place where you browse."
        ),
        EssaySection.new(
          title: "The important boundary is server dependence",
          body: "ArchiveBox offers more ingestion, automation, output formats, and operator control. AWSM currently offers less automation by design, but a sharper local privacy boundary and a Vault model with Recovery Phrase access. This is a choice between an archive system you operate and a personal archive that starts on the device where the page is seen."
        )
      ],
      sources: [
        Source.new(label: "ArchiveBox home", url: "https://archivebox.io/"),
        Source.new(label: "ArchiveBox documentation", url: "https://docs.archivebox.io/latest/README.html")
      ],
      reviewed_on: "4 August 2026"
    ),
    Comparison.new(
      slug: "singlefile",
      name: "SingleFile",
      category: "Browser capture",
      badge: "Browser capture",
      title: "AWSM and SingleFile: a page file or a personal archive?",
      description: "Compare one portable HTML file with an organized, encrypted archive that can grow over time.",
      official_url: "https://github.com/gildas-lormeau/SingleFile",
      alternative_intro: "SingleFile focuses on saving a complete web page as a self-contained HTML file from the browser.",
      awsm_intro: "AWSM turns a browser observation into an immutable Capture in a local encrypted Vault.",
      alternative_strengths: [
        "Save a complete page into one HTML file that is easy to move or open.",
        "Annotate, save selected content, process multiple tabs, and auto-save pages.",
        "Use a browser extension or CLI across many browsers and platforms."
      ],
      awsm_strengths: [
        "Keep Captures organized in a Library instead of managing individual files.",
        "Recover Vault access with a client-held Recovery Phrase.",
        "Retain a canonical Capture graph with screenshots, extracted text, and history."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Save a faithful, portable page file", awsm: "Build a personal web archive"),
        MatrixRow.new(label: "Main artifact", alternative: "A self-contained HTML file", awsm: "An immutable Capture Bundle in a Vault"),
        MatrixRow.new(label: "Organization", alternative: "Browser downloads, folders, or another destination", awsm: "Library, Folders, Tags, Notes, and Vault history"),
        MatrixRow.new(label: "Offline access", alternative: "Open the saved file directly", awsm: "Open local Captures through the Client"),
        MatrixRow.new(label: "Multi-device model", alternative: "Move or upload files using your chosen storage", awsm: "Optional encrypted Replica synchronization"),
        MatrixRow.new(label: "Capture controls", alternative: "Selected content, frames, tabs, annotations, and auto-save", awsm: "A validated page snapshot plus optional derivatives"),
        MatrixRow.new(label: "Privacy boundary", alternative: "You choose the file destination and sharing path", awsm: "Encrypted local Vault; a Host cannot decrypt synchronized items"),
        MatrixRow.new(label: "Best fit", alternative: "A single portable artifact or browser automation", awsm: "A durable collection with recovery and organization")
      ],
      essay: [
        EssaySection.new(
          title: "Choose SingleFile when the file is the product",
          body: "SingleFile is wonderfully direct. If you want to save a page, keep one HTML file, and open or move it with ordinary tools, its focus is an advantage. It also offers useful browser controls such as selected content, multiple tabs, annotations, and auto-save."
        ),
        EssaySection.new(
          title: "Choose AWSM when the collection matters",
          body: "AWSM treats a Capture as part of an archive rather than as a download. The Client stores the Capture in a Vault with Library organization, related Notes and Tags, a Recovery Phrase, and a path to optional encrypted synchronization. The goal is to return to a body of saved material, not just find a file in a folder."
        ),
        EssaySection.new(
          title: "Portability and continuity are different strengths",
          body: "SingleFile has a simpler portability story because its HTML file can stand alone. AWSM has a stronger continuity story for a growing personal archive because the Vault preserves structure and recovery. AWSM is not a replacement for a plain exported page file when a standalone file is the requirement."
        )
      ],
      sources: [
        Source.new(label: "SingleFile repository", url: "https://github.com/gildas-lormeau/SingleFile"),
        Source.new(label: "SingleFile file-format comparison", url: "https://github.com/gildas-lormeau/SingleFile#file-format-comparison")
      ],
      reviewed_on: "4 August 2026"
    ),
    Comparison.new(
      slug: "wallabag",
      name: "wallabag",
      category: "Read later",
      badge: "Read later",
      title: "AWSM and wallabag: read later or preserve the page?",
      description: "Compare a focused reading archive with a local-first archive of the page itself.",
      official_url: "https://wallabag.org/",
      alternative_intro: "wallabag is a read-it-later application that extracts article content into a comfortable reading view.",
      awsm_intro: "AWSM preserves a browser page snapshot as an encrypted Capture that remains in your local Vault.",
      alternative_strengths: [
        "Remove distractions and focus on article text.",
        "Use apps, browser extensions, RSS feeds, e-readers, and an API.",
        "Self-host the reading archive or use a managed service."
      ],
      awsm_strengths: [
        "Keep more of the page context than an article-only reading view.",
        "Use local Captures without an Account or online service.",
        "Organize a broader archive of pages, screenshots, text, Notes, and Tags."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Save and read articles later", awsm: "Preserve pages as personal Captures"),
        MatrixRow.new(label: "Saved view", alternative: "Extracted article content with distractions removed", awsm: "A browser-independent page snapshot plus derivatives"),
        MatrixRow.new(label: "Reading workflow", alternative: "Unread, starred, archived, filtered, and estimated reading time", awsm: "Library browsing and Capture history"),
        MatrixRow.new(label: "Offline access", alternative: "Available through supported apps and local instance workflows", awsm: "Local Captures remain usable without a network"),
        MatrixRow.new(label: "Input ecosystem", alternative: "Apps, extensions, feeds, e-readers, and imports", awsm: "The active page selected in the trusted browser"),
        MatrixRow.new(label: "Privacy boundary", alternative: "Self-hosting gives control over the reading service and its storage", awsm: "The Client holds Vault keys; optional Host sees opaque encrypted data"),
        MatrixRow.new(label: "Best discovery tool", alternative: "Article filters, tags, and reading status", awsm: "Library, Folders, Tags, Notes, and local search direction"),
        MatrixRow.new(label: "Best fit", alternative: "A calm queue of articles to read", awsm: "A durable archive where page context matters")
      ],
      essay: [
        EssaySection.new(
          title: "Choose wallabag for a reading queue",
          body: "wallabag has a clear and valuable purpose: save articles, remove distractions, and read them later. Its ecosystem of apps, readers, feeds, and APIs is a strong fit when reading comfort and queue management are the center of the workflow."
        ),
        EssaySection.new(
          title: "Choose AWSM when the source matters",
          body: "AWSM is aimed at the page as an archive artifact. A Capture keeps the source address, page snapshot, screenshot, and extracted representations together in the Vault. That is useful when layout, context, supporting material, or a private page matters as much as the article text."
        ),
        EssaySection.new(
          title: "A reading view and an archive answer different questions",
          body: "wallabag is optimized for returning to readable articles. AWSM is optimized for keeping a local record of what you saw. AWSM does not currently offer wallabag’s article queue, reader ecosystem, or managed reading service, and wallabag is not designed around AWSM’s encrypted Vault and Recovery Phrase model."
        )
      ],
      sources: [
        Source.new(label: "wallabag home", url: "https://wallabag.org/"),
        Source.new(label: "wallabag documentation", url: "https://doc.wallabag.org/")
      ],
      reviewed_on: "4 August 2026"
    ),
    Comparison.new(
      slug: "raindrop",
      name: "Raindrop.io",
      category: "Bookmark management",
      badge: "Cloud bookmarks",
      title: "AWSM and Raindrop.io: organized bookmarks or local custody?",
      description: "Compare a polished bookmark service with a local-first encrypted archive.",
      official_url: "https://raindrop.io/",
      alternative_intro: "Raindrop.io is a polished bookmark library with collections, highlights, search, permanent copies, backups, and collaboration.",
      awsm_intro: "AWSM is a local-first archive where the usable Vault starts on your device and a Host is optional.",
      alternative_strengths: [
        "Find saved pages, PDFs, and other content with full-text search.",
        "Use highlights, annotations, reminders, collections, and collaboration.",
        "Get a polished multi-device cloud experience with backups and uploads."
      ],
      awsm_strengths: [
        "Keep the primary archive local without creating an Account.",
        "Capture and open saved pages offline in an encrypted Vault.",
        "Choose an opaque Replica Host without handing it Vault decryption keys."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Organize and rediscover bookmarks", awsm: "Preserve a personal archive"),
        MatrixRow.new(label: "Storage model", alternative: "Cloud library with optional uploads and backups", awsm: "Encrypted browser-local Vault with optional Replicas"),
        MatrixRow.new(label: "Discovery", alternative: "Collections, tags, highlights, reminders, and full-text search", awsm: "Library organization and local Vault-derived views"),
        MatrixRow.new(label: "Offline access", alternative: "Depends on supported app behavior and available synchronized data", awsm: "Local Captures remain usable without a network"),
        MatrixRow.new(label: "Collaboration", alternative: "Shared collections and annotations", awsm: "Vault membership is part of the portable encrypted Vault model"),
        MatrixRow.new(label: "Capture boundary", alternative: "Bookmarks, saved copies, files, and highlights", awsm: "A validated page snapshot and its Capture artifacts"),
        MatrixRow.new(label: "Privacy boundary", alternative: "A service account and its cloud operating model", awsm: "No Account for local use; optional Host receives opaque encrypted items"),
        MatrixRow.new(label: "Best fit", alternative: "Fast cloud organization and discovery across devices", awsm: "Local ownership and private archival continuity")
      ],
      essay: [
        EssaySection.new(
          title: "Choose Raindrop.io for polished discovery",
          body: "Raindrop.io is compelling when the main problem is organizing a large collection of bookmarks. Its collections, highlights, full-text search, reminders, backups, and collaboration features make returning to saved material easy across devices."
        ),
        EssaySection.new(
          title: "Choose AWSM for local custody",
          body: "AWSM starts with a different promise: the archive remains usable on the Client, and local use does not require an Account. Synchronization is optional and the Host receives opaque encrypted items rather than a readable web library."
        ),
        EssaySection.new(
          title: "Convenience and custody are separate choices",
          body: "Raindrop.io has a stronger ready-made service experience and broader bookmark collaboration. AWSM has a stronger local-first boundary and a Vault recovery model. AWSM is not currently a cloud bookmark dashboard, and Raindrop.io is not built around a client-held Recovery Phrase."
        )
      ],
      sources: [
        Source.new(label: "Raindrop.io Pro features", url: "https://raindrop.io/pro"),
        Source.new(label: "Raindrop.io highlights", url: "https://help.raindrop.io/highlights")
      ],
      reviewed_on: "4 August 2026"
    ),
    Comparison.new(
      slug: "karakeep",
      name: "Karakeep",
      category: "Bookmark management",
      badge: "Self-hosted bookmarks",
      title: "AWSM and Karakeep: bookmark everything or preserve a Vault?",
      description: "Compare an automation-rich self-hosted bookmark hub with a local-first encrypted archive.",
      official_url: "https://karakeep.app/",
      alternative_intro: "Karakeep is a self-hostable bookmark-everything app for links, notes, images, files, search, automation, and optional AI features.",
      awsm_intro: "AWSM is a browser-first archive whose encrypted Vault is the primary application environment.",
      alternative_strengths: [
        "Save links, notes, images, PDFs, highlights, and attachments.",
        "Use mobile apps, browser extensions, RSS, APIs, rules, and collaboration.",
        "Add full-text search, OCR, automatic tagging, summarization, and page archiving."
      ],
      awsm_strengths: [
        "Keep the usable archive local before adding any server.",
        "Use a client-held Recovery Phrase and portable Vault membership.",
        "Separate encrypted synchronization from the place where you browse and search."
      ],
      matrix: [
        MatrixRow.new(label: "Primary job", alternative: "Self-hosted bookmark-everything hub", awsm: "Local-first web archive"),
        MatrixRow.new(label: "Saved material", alternative: "Links, notes, images, PDFs, highlights, and attachments", awsm: "Page Capture Bundles with screenshots, text, and structured content"),
        MatrixRow.new(label: "Discovery", alternative: "Full-text search, rules, OCR, tags, and optional AI", awsm: "Library organization and local derived views"),
        MatrixRow.new(label: "Automation", alternative: "RSS, APIs, CLI, browser clients, and automatic fetching", awsm: "Explicit browser Capture in the current preview"),
        MatrixRow.new(label: "Mobile", alternative: "iOS and Android apps", awsm: "Mobile clients are not shipped in the current preview"),
        MatrixRow.new(label: "Collaboration", alternative: "Shared lists and multi-user service workflows", awsm: "Portable Vault membership and encrypted event history"),
        MatrixRow.new(label: "Privacy boundary", alternative: "You operate the self-hosted service or choose its managed offering", awsm: "Client-held Vault keys; optional Host stores opaque encrypted bytes"),
        MatrixRow.new(label: "Best fit", alternative: "An active personal or team bookmark operations hub", awsm: "A private archive whose primary copy starts on the device")
      ],
      essay: [
        EssaySection.new(
          title: "Choose Karakeep for a broad bookmark hub",
          body: "Karakeep is a strong self-hosted alternative when you want to throw many kinds of material into one place and retrieve it later. Mobile apps, shared lists, APIs, RSS, rules, full-text search, OCR, and optional AI make it an ambitious personal information hub."
        ),
        EssaySection.new(
          title: "Choose AWSM for an archive with a hard privacy boundary",
          body: "AWSM is narrower by design. The browser Client creates and validates the Capture, the encrypted Vault is the primary application environment, and a Coordination Server is only an optional opaque Replica Host. The result is less automation and fewer clients today, but a clearer separation between Vault content and synchronization infrastructure."
        ),
        EssaySection.new(
          title: "The difference is the center of gravity",
          body: "Karakeep puts the bookmark service at the center and adds powerful retrieval around it. AWSM puts the local Vault at the center and treats servers as optional synchronization channels. Neither model is universally better; the choice depends on whether your first need is an information hub or private archival custody."
        )
      ],
      sources: [
        Source.new(label: "Karakeep repository", url: "https://github.com/karakeep-app/karakeep"),
        Source.new(label: "Karakeep bookmarking documentation", url: "https://docs.karakeep.app/using-karakeep/bookmarking/"),
        Source.new(label: "Karakeep configuration", url: "https://docs.karakeep.app/configuration/environment-variables/")
      ],
      reviewed_on: "4 August 2026"
    )
  ].freeze

  def self.all
    COMPARISONS
  end

  def self.categories
    CATEGORIES
  end

  def self.find(slug)
    COMPARISONS.find { |comparison| comparison.slug == slug }
  end

  def self.validate!
    raise "Comparison slugs must be unique." unless COMPARISONS.map(&:slug).uniq.length == COMPARISONS.length
    raise "Comparison categories must be declared." unless COMPARISONS.all? { |comparison| CATEGORIES.any? { |category| category.title == comparison.category } }
    raise "Comparison pages require reviewed dates." unless COMPARISONS.all? { |comparison| comparison.reviewed_on.present? }
    raise "Comparison pages require source links." unless COMPARISONS.all? { |comparison| comparison.sources.any? }
    raise "Comparison matrices must be complete." unless COMPARISONS.all? { |comparison| comparison.matrix.length >= 8 }
  end

  validate!
end
