module ApplicationHelper
  PUBLIC_REPOSITORY = "https://github.com/mashuproject/awsm_bak".freeze

  def public_product_links
    {
      source: PUBLIC_REPOSITORY,
      releases: "#{PUBLIC_REPOSITORY}/releases/latest",
      documentation: "#{PUBLIC_REPOSITORY}/tree/main/docs",
      chrome_guide: "#{PUBLIC_REPOSITORY}/blob/main/docs/guides/install-chrome-extension.md",
      firefox_guide: "#{PUBLIC_REPOSITORY}/blob/main/docs/guides/install-firefox-extension.md",
      desktop_guide: "#{PUBLIC_REPOSITORY}/blob/main/docs/guides/install-desktop-runtime.md",
      self_hosting: "#{PUBLIC_REPOSITORY}/blob/main/apps/coordination-server/README.md",
      security_model: "#{PUBLIC_REPOSITORY}/blob/main/docs/architecture/04-security-model.md",
      license: "#{PUBLIC_REPOSITORY}/blob/main/LICENSE"
    }.freeze
  end

  def keeper_image(variant: "keeper", **options)
    image_tag "assets/icons/#{variant}.svg", { alt: "", aria: { hidden: true } }.merge(options)
  end

  def glossary_term_link(term, label = term)
    link_to label, glossary_path(anchor: term.parameterize), class: "term-link", data: { turbo: false }
  end

  def glossary_summary(term)
    return ERB::Util.html_escape(term.summary) if term.linked_titles.empty?

    titles = term.linked_titles.sort_by { |title| -title.length }
    pattern = Regexp.union(titles)
    safe_join(term.summary.split(/(#{pattern})/).map do |part|
      titles.include?(part) ? glossary_term_link(part) : ERB::Util.html_escape(part)
    end)
  end
end
