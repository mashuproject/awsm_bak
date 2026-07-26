module ApplicationHelper
  PUBLIC_REPOSITORY = "https://github.com/mashuproject/awsm_bak".freeze

  def public_product_links
    {
      source: PUBLIC_REPOSITORY,
      releases: "#{PUBLIC_REPOSITORY}/releases/latest",
      documentation: "#{PUBLIC_REPOSITORY}/tree/main/docs",
      chrome_guide: "#{PUBLIC_REPOSITORY}/blob/main/docs/guides/install-chrome-extension.md",
      firefox_guide: "#{PUBLIC_REPOSITORY}/blob/main/docs/guides/install-firefox-extension.md",
      self_hosting: "#{PUBLIC_REPOSITORY}/blob/main/apps/coordination-server/README.md",
      security_model: "#{PUBLIC_REPOSITORY}/blob/main/docs/architecture/04-security-model.md",
      license: "#{PUBLIC_REPOSITORY}/blob/main/LICENSE"
    }.freeze
  end

  def keeper_image(variant: "keeper", **options)
    image_tag "assets/icons/#{variant}.svg", { alt: "", aria: { hidden: true } }.merge(options)
  end
end
