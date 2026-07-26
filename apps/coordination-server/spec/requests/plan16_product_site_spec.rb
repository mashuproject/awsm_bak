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
      "Take your Vault with you",
      "What works today",
      "Why not just use the Wayback Machine?",
      "Continue without sync",
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
  end

  it "shows the server origin and registration state without creating a global signup conversion" do
    allow(Coordination::Registration).to receive(:enabled?).and_return(false)

    get "/", headers: { "HOST" => "sync.example.test" }

    expect(response.body).to include("http://sync.example.test")
    expect(response.body).to include("Account creation is currently closed")
    expect(response.body).not_to include('href="/sign_up"')
  end

  it "renders factual privacy and security explanations" do
    get "/privacy"
    expect(response).to have_http_status(:ok)
    expect(response.body).to include("operational metadata", "no analytics")

    get "/security"
    expect(response).to have_http_status(:ok)
    expect(response.body).to include("The server coordinates. The client holds the keys.")
    expect(response.body).to include("Account password", "Recovery Phrase")
  end

  it "defines capitalized product concepts in a public glossary" do
    get "/glossary"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "The language of your archive.",
      "Capture",
      "Complete Export",
      "Vault",
      "Recovery Phrase",
      "Coordination Server"
    )
  end

  it "keeps the landing visible after browser authentication and adds a sync banner" do
    Account.create!(
      email: "reader@example.test",
      password: "test account password",
      password_confirmation: "test account password"
    )
    post "/session", params: {
      email: "reader@example.test",
      password: "test account password"
    }

    get "/"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include(
      "Archive what should matter.",
      "Signed in as",
      "reader@example.test",
      "Set up sync"
    )
  end

  it "exposes the rendered design fixture in test" do
    get "/design-system"

    expect(response).to have_http_status(:ok)
    expect(response.body).to include("AWSM Bright Utility Kit", "Controls and states")
  end
end
