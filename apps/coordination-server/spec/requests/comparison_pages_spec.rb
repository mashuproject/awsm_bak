require "rails_helper"

RSpec.describe "Comparison pages", type: :request do
  let(:slugs) do
    %w[wayback-machine archivebox singlefile wallabag raindrop karakeep]
  end

  it "renders the comparison hub as public product documentation" do
    get "/compare"

    expect(response).to have_http_status(:ok)
    expect(response.headers["Cache-Control"]).to include("public")
    expect(response.body).to include(
      "Compare tools",
      "Choose the archive that fits your work.",
      "AWSM today",
      "Desktop Runtime",
      "v0.3.4",
      "hosted web reader",
      "Wayback Machine",
      "ArchiveBox",
      "SingleFile",
      "wallabag",
      "Raindrop.io",
      "Karakeep",
      "Read later",
      "Bookmark management",
      "No affiliation"
    )
    expect(response.body).to include('<meta name="description"')
    expect(response.body).to include('href="/"')
    expect(response.body).to include('href="/glossary#local-first"')
    expect(response.body).to include(
      'href="https://github.com/mashuproject/awsm_bak/releases/tag/v0.3.4"'
    )
  end

  it "renders every comparison with a guide, matrix, sources, and review date" do
    slugs.each do |slug|
      comparison = ComparisonCatalog.find(slug)

      get "/compare/#{slug}"

      expect(response).to have_http_status(:ok), slug
      expect(response.headers["Cache-Control"]).to include("public"), slug
      expect(response.body).to include(
        "Choose #{comparison.name} when",
        "Choose AWSM when",
        "At a glance",
        "Sources",
        comparison.reviewed_on,
        "No affiliation",
        comparison.official_url
      ), slug
      expect(response.body).to include("Mobile clients are not shipped in the current release") if slug == "karakeep"

      document = Nokogiri::HTML(response.body)
      expect(document.at_css("h1").text).to include("AWSM and"), slug
      expect(document.css(".compare-matrix tbody tr").length).to eq(comparison.matrix.length), slug
      expect(document.css(".compare-matrix th").map(&:text)).to include(comparison.name, "AWSM"), slug
      expect(document.css(".compare-sources a").length).to eq(comparison.sources.length), slug
      expect(document.at_css('meta[name="description"]')["content"]).to include("AWSM"), slug
    end
  end

  it "returns not found for an unknown comparison" do
    get "/compare/not-a-real-tool"

    expect(response).to have_http_status(:not_found)
  end

  it "keeps comparison pages anonymous and free of session details" do
    Account.create!(
      username: "comparison-reader",
      password: "test account password",
      password_confirmation: "test account password",
      last_activity_at: Time.current
    )
    post "/session", params: {
      username: "comparison-reader",
      password: "test account password"
    }

    get "/compare/wayback-machine"

    expect(response).to have_http_status(:ok)
    expect(response.body).not_to include("Signed in as", "comparison-reader", "authenticity_token")
  end

  it "keeps the catalog complete and internally consistent" do
    expect { ComparisonCatalog.validate! }.not_to raise_error
    expect(ComparisonCatalog.all.map(&:slug)).to match_array(slugs)
    expect(ComparisonCatalog.all.map(&:slug).uniq.length).to eq(slugs.length)
    expect(ComparisonCatalog.all).to all(satisfy { |comparison| comparison.sources.all? { |source| URI(source.url).is_a?(URI::HTTPS) } })
  end
end
