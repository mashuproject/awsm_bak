require "rails_helper"

RSpec.describe "Plan 16 product site", type: :request do
  it "renders the public-preview landing at the root without authentication" do
    get "/"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "Archive what should matter.",
      "Keep useful pages available offline, even when the web moves on.",
      "AWSM preservation features",
      "Public preview",
      "Get AWSM",
      "A bookmark points back. A Capture stays with you.",
      "Keeps the Capture together",
      "What works today",
      "Capture a page locally. Keep control of the Vault.",
      "Attach a Hosted Replica when you choose.",
      "Optional synchronization through opaque Replicas.",
      "Why not just use the Wayback Machine?",
      "Mozilla-signed Linux beta",
      "Sign in"
    )
    expect(response.body).not_to include(
      "google-analytics",
      "googletagmanager",
      "fonts.googleapis.com",
      "Proof, not promises",
      "pricing",
      "waitlist"
    )
    expect(response.body).to include('href="/glossary#capture"')
    expect(response.body).to include('href="/glossary#hosted-replica"')

    document = Nokogiri::HTML(response.body)
    expect(document.css("#optional-sync .section-heading").map(&:text)).to eq(
      [ "Optional synchronization through opaque Replicas." ]
    )
    expect(document.at_css("#install-awsm").text).not_to match(
      /synchronization|another browser|continue without sync/i
    )
    expect(response.body).not_to include("verified Export and Import", "private per-Vault keyword Search")
  end

  it "shows the server origin and registration state without creating a global signup conversion" do
    allow(Coordination::Registration).to receive(:enabled?).and_return(false)
    allow(Coordination::Registration).to receive(:public_origin).and_return("http://sync.example.test")

    get "/"

    expect(response.body).to include("http://sync.example.test")
    expect(response.body).to include("Account creation is currently closed")
    expect(response.body).not_to include('href="/sign_up"')
  end

  it "renders factual privacy and security explanations" do
    get "/privacy"
    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "Host-local access and quota records for",
      "Hosted Replicas",
      "opaque encrypted item bytes",
      "cannot decrypt the items",
      "no analytics"
    )
    expect(response.body).not_to include("Device certificates", "remote embedding endpoint")
    expect(response.body).to include('href="/glossary#client-installation"')

    get "/security"
    expect(response).to have_http_status(:ok)
    expect(response.body).to include("The server coordinates. The client holds the keys.")
    expect(response.body).to include(
      "Account password",
      "Recovery Phrase",
      "Replica Access Grant",
      "Client Credential"
    )
    expect(response.body).not_to include("Device removal", "remote embedding endpoint")
    expect(response.body).to include('href="/glossary#replica-access-grant"')
  end

  it "defines an alphabetized plain-language public glossary" do
    get "/glossary"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "The language of your archive.",
      "These short entries explain the words used on this site.",
      "Capture",
      "Complete Export",
      "Replica Access Grant",
      "Vault",
      "Recovery Phrase",
      "Coordination Server"
    )
    expect(response.body).not_to include("Vault Record", "<dt>Device</dt>")

    document = Nokogiri::HTML(response.body)
    expected_sections = {
      "Your archive and access" => [
        "Account", "Capture", "Client Credential", "Client Installation", "Complete Export",
        "Recovery Phrase", "Vault", "Vault ID", "Vault Member"
      ],
      "Copies and synchronization" => [
        "Coordination Server", "Hosted Replica", "Replica", "Replica Access Grant", "Replica Host",
        "Storage Relief", "Synchronization Cycle"
      ],
      "Saved items" => [ "Folder", "Library", "Note", "Tag" ]
    }

    expect(document.css(".glossary-list__section").to_h do |section|
      [ section.at_css("h2").text, section.css("dt").map(&:text) ]
    end).to eq(expected_sections)
    expect(document.css(".glossary-list__section").flat_map { |section| section.css("dt").map(&:text) }).to all(
      satisfy { |title| CanonicalGlossary.source_term_titles.include?(title) }
    )
    expect(document.css(".glossary-list__section").all? do |section|
      terms = section.css("dt").map(&:text)
      terms == terms.sort_by(&:downcase)
    end).to be(true)
  end

  it "keeps the landing cache-safe after browser authentication and exposes enhancement targets" do
    Account.create!(
      username: "reader",
      password: "test account password",
      password_confirmation: "test account password",
      last_activity_at: Time.current
    )
    post "/session", params: {
      username: "reader",
      password: "test account password"
    }

    get "/"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "Archive what should matter.",
      "Signed in as",
      "Set up sync",
      'data-public-session-target="banner"'
    )
    expect(response.body).not_to include("reader", "authenticity_token")
  end

  it "exposes the rendered design fixture in test" do
    get "/design-system"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("AWSM Bright Utility Kit", "Controls and states")
  end
end
