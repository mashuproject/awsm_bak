# AWSM Vision

> Knowledge should remain under the control of the people who preserve it.

# Purpose

The web is ephemeral. Articles disappear, pages change, discussions are removed, and services end.
Bookmarks preserve locations, not knowledge. Cloud clipping and AI products often require people to
trade away privacy or continued access for convenience.

AWSM exists to preserve digital knowledge faithfully, privately, searchably, and independently of
any particular vendor or service.

# Vision

AWSM is a local-first encrypted knowledge-preservation platform. Trusted Clients capture,
organize, search, and interpret content. A Vault can exist through any number of local, peer, or
hosted Replicas without one canonical cloud copy. Optional Hosts store and transfer opaque data but
do not need the keys or semantic metadata required to read it.

The browser extension is the first Client, not the limit of the platform. Desktop, mobile,
headless, API-driven, and future thin Clients should share one portable Vault architecture.

# What trustworthy means

AWSM is trustworthy when:

- original observations remain independently verifiable;
- plaintext and private keys stay in trusted Clients by default;
- ordinary use remains useful offline and during service failure;
- no synchronization provider becomes the owner or sole source of Vault truth;
- current state, history rewrites, conflicts, and destructive consequences are honest;
- recovery belongs to each Vault Member rather than a service operator;
- complete export and independent Fork remain available; and
- formats, implementations, and providers can evolve without trapping knowledge.

# Guiding principles

## Local first

Capture, encryption, decryption, Event authoring, replay, organization, rendering, keyword search,
and ordinary AI processing happen in trusted Clients. A Remote is optional. Network partition may
delay convergence but does not stop permitted local work.

An On-demand Replica may deliberately evict heavy wrappers while retaining compact authority and
retrieval knowledge. Storage Relief is an informed availability trade-off, never a claim that some
other copy certainly exists.

## Opaque remote storage

A Replica Host authenticates its own Channel Principals, applies Grants and quota, and stores
randomized Opaque Storage Items. Account is one optional Host-local login model, not a Vault
identity. A username and password can open a synchronization Channel without deriving keys,
granting membership, or turning the website into a duplicate Vault application.

Traffic timing, item sizes, and Host-local associations remain observable. AWSM should minimize and
describe that metadata rather than make an impossible claim of perfect anonymity.

## Immutable preservation

A Capture is an immutable Bundle of preserved Artifacts. Corrections, labels, organization, Notes,
derived interpretations, and lifecycle changes are additive signed Events. The system never edits
an original observation in place.

Delete remains reversible until an informed Vacuum establishes a new Baseline. Vacuum cannot erase
copies held elsewhere. A member who disagrees can preserve history through Complete Export or make
an independent state-only Fork.

## Members are cryptographic peers

Every Vault Member receives the same access and recovery class. Roles govern shared Vault
coordination, not whose copy is more real or who deserves recovery. One or more Administrators may
authorize Invitation creation, membership, security transitions, Vacuum, and Closure; each has
independent disclosed authority and is treated as an adult. Cancelling one Invitation requires its
separately retained or delegated Cancellation Capability rather than Administrator status alone.

Each member controls a Recovery Phrase and may enroll a fresh Client Credential without another
client remaining online. Possession of that phrase is possession of sensitive Vault access. A
compact signed Continuity Proof survives Vacuum so recovery can authenticate the current Baseline
without trusting a storage Host.

## Explicit evolution

AWSM has one signed hash-linked Record DAG, an Authority Parent subgraph of those same Records,
deterministic reduction, and canonical Baselines. Required Vault Features explicitly define new
authoritative data, reducers, reachability, and unsupported-client behavior. Advisory Extensions
cannot quietly change meaning.

Before the first compatibility obligation exists, AWSM implements one clean canonical design and
discards superseded experiments rather than preserving them as permanent complexity.

## AI augments preserved knowledge

Search, embeddings, OCR, summaries, and other generated views are replaceable local
Materializations by default. Better models rebuild better indexes without migrating false
authority. A generated result becomes shared Vault content only through an explicit user action and
typed portable contract.

Remote plaintext processing is a visible exception that requires separate consent and exact
provider scope. Zero-knowledge storage never disguises that disclosure.

## Open, portable architecture

Vault semantics are independent of browser, framework, database, cloud, authentication method,
storage provider, and AI provider. Clients and Hosts are composable roles. Complete Exports and
Backups are static transfer artifacts, while Replicas remain live synchronization participants.

# Product shape

```text
external source
  -> trusted Capture adapter
  -> immutable Bundle and Artifact Objects
  -> signed Vault Event DAG
  -> local Library and Search projections
  -> optional opaque Replica synchronization
```

Collections group observations of one subject. Folders organize Collections. Tags and Notes can
target a Collection or exact Capture. Names and titles are presentation, never identity.

# Long-term capabilities

The stable architecture should admit new Capture adapters, peer transports, scheduled Capture,
change comparison, semantic retrieval, citation-grounded assistance, encrypted collaboration,
desktop and mobile Clients, self-hosted headless Clients, and alternative opaque Hosts without
redesigning the Vault or granting a provider plaintext access.

# Anti-goals

AWSM is not intended to become:

- a cloud-first editor whose service is the source of truth;
- a social network, advertising system, or surveillance platform;
- a centralized plaintext AI corpus;
- a collaborative wiki with hidden last-writer-wins data loss;
- a retention promise that claims to know every extant copy; or
- a compatibility museum for abandoned pre-release formats.

# Decision test

A proposal should answer:

1. Does it preserve faithful source evidence?
2. Does it keep plaintext and authority inside the correct trust boundary?
3. Can permitted work continue offline?
4. Does it converge without silently discarding authenticated work?
5. Can a person export or Fork without the provider?
6. Does it add a real semantic need rather than a provider-specific shortcut?
7. Is any irreversible consequence clear before action?

# North star

AWSM is not a browser extension, Rails service, or cloud account. It is a durable encrypted Vault
architecture through which people can preserve and understand knowledge on their own terms.
