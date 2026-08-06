package vault

import (
	"bytes"
	"crypto/ed25519"
	cryptorand "crypto/rand"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type CreationIDs struct {
	VaultID              [32]byte
	GenerationID         [32]byte
	FirstMemberID        [32]byte
	ClientCredentialID   [32]byte
	RecoveryCredentialID [32]byte
	LabelCauseID         [32]byte
}

type CreationInput struct {
	Label                        *string
	AssertedAt                   int64
	RecoveryPhrase               string
	FeatureManifests             []canonical.FeatureManifestInput
	IDs                          *CreationIDs
	ClientSigningSeed            []byte
	ClientWrappingPrivateKey     []byte
	KeyEpochKey                  []byte
	EnvelopePadding              []byte
	EnvelopeEphemeralSeed        []byte
	BaselineProtectionParameters []byte
	GenesisProtectionParameters  []byte
}

type PreparedCanonicalFeatureManifest struct {
	Manifest canonical.FeatureManifest
	ID       [32]byte
	Bytes    []byte
	Envelope storage.OpaqueEnvelope
}

type PreparedCanonicalVaultCreation struct {
	RecoveryPhrase       string
	IDs                  CreationIDs
	RequiredFeatureSetID [32]byte
	ClientKeys           awsmcrypto.CredentialKeys
	RecoveryKeys         awsmcrypto.CredentialKeys
	KeyEpochKey          []byte
	KeyEpochID           [32]byte
	ClientCertificate    canonical.Value
	RecoveryCredential   canonical.Value
	ClientKeyEnvelope    awsmcrypto.KeyEnvelope
	RecoveryKeyEnvelope  awsmcrypto.KeyEnvelope
	FeatureManifests     []PreparedCanonicalFeatureManifest
	BaselineEnvelope     storage.OpaqueEnvelope
	GenesisEnvelope      storage.OpaqueEnvelope
	Baseline             canonical.Baseline
	Genesis              canonical.Event
}

func PrepareCanonicalVaultCreation(input CreationInput) (PreparedCanonicalVaultCreation, error) {
	if input.RecoveryPhrase == "" {
		return PreparedCanonicalVaultCreation{}, errors.New("Recovery Phrase is required")
	}
	entropy, err := awsmcrypto.DecodeRecoveryPhrase(input.RecoveryPhrase)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	recoveryKeys, err := awsmcrypto.DeriveRecoveryCredential(entropy)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	clientKeys, err := awsmcrypto.CreateClientCredentialKeys(input.ClientSigningSeed, input.ClientWrappingPrivateKey)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	ids, err := creationIDs(input.IDs)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	epochKey := append([]byte(nil), input.KeyEpochKey...)
	if len(epochKey) == 0 {
		epochKey = make([]byte, 32)
		if _, err := io.ReadFull(cryptorand.Reader, epochKey); err != nil {
			return PreparedCanonicalVaultCreation{}, fmt.Errorf("generate initial Key Epoch Key: %w", err)
		}
	}
	if len(epochKey) != 32 {
		return PreparedCanonicalVaultCreation{}, errors.New("initial Key Epoch Key must contain exactly 32 bytes")
	}
	epochID, err := awsmcrypto.KeyEpochID(ids.VaultID, epochKey)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	requiredFeatureSetID, err := canonical.RequiredFeatureSetID(input.FeatureManifests)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, fmt.Errorf("prepare Required Feature Set: %w", err)
	}
	featureManifests := make([]PreparedCanonicalFeatureManifest, 0, len(input.FeatureManifests))
	for _, featureInput := range input.FeatureManifests {
		manifestBytes, encodeErr := canonical.EncodeFeatureManifest(featureInput)
		if encodeErr != nil {
			return PreparedCanonicalVaultCreation{}, fmt.Errorf("encode Feature Manifest: %w", encodeErr)
		}
		manifest, decodeErr := canonical.DecodeFeatureManifest(manifestBytes)
		if decodeErr != nil {
			return PreparedCanonicalVaultCreation{}, fmt.Errorf("decode Feature Manifest: %w", decodeErr)
		}
		manifestEnvelopeBytes, sealErr := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
			VaultID: ids.VaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
			PayloadType: 3, PayloadBytes: manifestBytes,
		})
		if sealErr != nil {
			return PreparedCanonicalVaultCreation{}, fmt.Errorf("protect Feature Manifest: %w", sealErr)
		}
		manifestEnvelope, decodeErr := storage.DecodeOpaqueEnvelope(manifestEnvelopeBytes)
		if decodeErr != nil {
			return PreparedCanonicalVaultCreation{}, fmt.Errorf("decode Feature Manifest envelope: %w", decodeErr)
		}
		featureManifests = append(featureManifests, PreparedCanonicalFeatureManifest{
			Manifest: manifest, ID: manifest.ID, Bytes: manifestBytes, Envelope: manifestEnvelope,
		})
	}
	recoveryRevision := uint64(0)
	recoveryEnvelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: ids.VaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		TargetKind: awsmcrypto.RecoveryCredentialTarget, TargetCredentialID: ids.RecoveryCredentialID,
		TargetRevision: &recoveryRevision, RecipientWrappingPublicKey: recoveryKeys.WrappingPublicKey,
		Padding: input.EnvelopePadding, EphemeralSeed: input.EnvelopeEphemeralSeed,
	})
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	clientEnvelope, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
		VaultID: ids.VaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		TargetKind: awsmcrypto.ClientCredentialTarget, TargetCredentialID: ids.ClientCredentialID,
		RecipientWrappingPublicKey: clientKeys.WrappingPublicKey,
		Padding:                    input.EnvelopePadding, EphemeralSeed: input.EnvelopeEphemeralSeed,
	})
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	clientCertificate := canonical.Map{
		0: append([]byte(nil), ids.ClientCredentialID[:]...),
		1: append([]byte(nil), ids.FirstMemberID[:]...),
		2: append([]byte(nil), clientKeys.SigningPublicKey...),
		3: append([]byte(nil), clientKeys.WrappingPublicKey...),
	}
	recoveryCredential := canonical.Map{
		0: append([]byte(nil), ids.RecoveryCredentialID[:]...),
		1: append([]byte(nil), ids.FirstMemberID[:]...),
		2: uint64(0),
		3: append([]byte(nil), recoveryKeys.SigningPublicKey...),
		4: append([]byte(nil), recoveryKeys.WrappingPublicKey...),
	}
	recoverySlot := canonical.Map{
		0: append([]byte(nil), epochID[:]...), 1: uint64(1), 2: append([]byte(nil), ids.RecoveryCredentialID[:]...),
		3: uint64(0), 4: append([]byte(nil), recoveryEnvelope.ID[:]...),
	}
	clientSlot := canonical.Map{
		0: append([]byte(nil), epochID[:]...), 1: uint64(2), 2: append([]byte(nil), ids.ClientCredentialID[:]...),
		3: nil, 4: append([]byte(nil), clientEnvelope.ID[:]...),
	}
	contentCheckpoint := canonical.Map{
		0: uint64(1),
		1: canonical.Map{0: cloneLabel(input.Label), 1: valuesForLabel(input.Label, ids.LabelCauseID)},
		2: []canonical.Value{}, 3: []canonical.Value{}, 4: []canonical.Value{}, 5: []canonical.Value{},
		6: []canonical.Value{}, 7: []canonical.Value{}, 8: []canonical.Value{}, 9: []canonical.Value{},
	}
	authorityCheckpoint := canonical.Map{
		0: uint64(1),
		1: []canonical.Value{append([]byte(nil), ids.FirstMemberID[:]...)},
		2: []canonical.Value{append([]byte(nil), ids.FirstMemberID[:]...)},
		3: []canonical.Value{clientCertificate}, 4: []canonical.Value{recoveryCredential},
		5: []canonical.Value{},
		6: []canonical.Value{canonical.Map{0: append([]byte(nil), epochID[:]...), 1: uint64(0), 2: true}},
		7: canonicalSetValues([]canonical.Value{recoverySlot, clientSlot}),
		8: []canonical.Value{}, 9: []canonical.Value{},
	}
	dependencies := []canonical.Dependency{
		{Type: 7, ID: clientEnvelope.ID}, {Type: 7, ID: recoveryEnvelope.ID},
	}
	for _, feature := range featureManifests {
		dependencies = append(dependencies, canonical.Dependency{Type: 8, ID: feature.ID})
	}
	sort.Slice(dependencies, func(left, right int) bool {
		if dependencies[left].Type != dependencies[right].Type {
			return dependencies[left].Type < dependencies[right].Type
		}
		return bytes.Compare(dependencies[left].ID[:], dependencies[right].ID[:]) < 0
	})
	baseline, err := canonical.EncodeBaseline(canonical.BaselineInput{
		VaultID: ids.VaultID, GenerationID: ids.GenerationID, Dependencies: dependencies,
		RequiredFeatureSetID: requiredFeatureSetID, Extensions: map[string][]byte{},
		Body: canonical.Map{0: uint64(1), 1: uint64(1), 2: contentCheckpoint, 3: authorityCheckpoint, 4: canonical.Map{0: uint64(1)}, 5: nil},
	})
	if err != nil {
		return PreparedCanonicalVaultCreation{}, fmt.Errorf("create Initial Baseline: %w", err)
	}
	proofTranscript, err := canonical.Transcript("awsm:genesis-possession-proof:v1",
		ids.VaultID[:], ids.GenerationID[:], baseline.RecordID[:], ids.FirstMemberID[:],
		mustCanonical(clientCertificate), mustCanonical(recoveryCredential), epochID[:], requiredFeatureSetID[:],
	)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, err
	}
	clientProof := ed25519.Sign(ed25519.PrivateKey(clientKeys.SigningSecretKey), proofTranscript)
	recoveryProof := ed25519.Sign(ed25519.PrivateKey(recoveryKeys.SigningSecretKey), proofTranscript)
	assertedAt := input.AssertedAt
	if assertedAt == 0 {
		assertedAt = time.Now().UnixMilli()
	}
	genesis, err := canonical.SignEvent(canonical.EventInput{
		VaultID: ids.VaultID, GenerationID: ids.GenerationID,
		ParentRecordIDs: []canonical.Identifier{}, AuthorityParentIDs: []canonical.Identifier{},
		Dependencies:         []canonical.Dependency{{Type: 2, ID: baseline.RecordID}},
		RequiredFeatureSetID: requiredFeatureSetID, Extensions: map[string][]byte{},
		Family: canonical.AuthorityFamily, Type: canonical.GenesisEvent,
		SignerCredentialID: ids.ClientCredentialID, AssertedAt: assertedAt,
		Body: canonical.Map{
			0: append([]byte(nil), baseline.RecordID[:]...), 1: append([]byte(nil), ids.FirstMemberID[:]...),
			2: clientCertificate, 3: recoveryCredential, 4: append([]byte(nil), epochID[:]...),
			5: append([]byte(nil), requiredFeatureSetID[:]...), 6: canonical.Map{0: clientProof, 1: recoveryProof},
		},
	}, ed25519.PrivateKey(clientKeys.SigningSecretKey))
	if err != nil {
		return PreparedCanonicalVaultCreation{}, fmt.Errorf("create Genesis: %w", err)
	}
	baselineEnvelope, err := sealInitialRecordEnvelope(ids.VaultID, epochID, epochKey, baselineProtectionParameters(input.BaselineProtectionParameters), baseline.Bytes)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, fmt.Errorf("protect Initial Baseline: %w", err)
	}
	genesisEnvelope, err := sealInitialRecordEnvelope(ids.VaultID, epochID, epochKey, baselineProtectionParameters(input.GenesisProtectionParameters), genesis.Bytes)
	if err != nil {
		return PreparedCanonicalVaultCreation{}, fmt.Errorf("protect Genesis: %w", err)
	}
	return PreparedCanonicalVaultCreation{
		RecoveryPhrase: input.RecoveryPhrase, IDs: ids, RequiredFeatureSetID: requiredFeatureSetID,
		ClientKeys: clientKeys, RecoveryKeys: recoveryKeys, KeyEpochKey: epochKey, KeyEpochID: epochID,
		ClientCertificate: clientCertificate, RecoveryCredential: recoveryCredential,
		ClientKeyEnvelope: clientEnvelope, RecoveryKeyEnvelope: recoveryEnvelope,
		FeatureManifests: featureManifests,
		BaselineEnvelope: baselineEnvelope, GenesisEnvelope: genesisEnvelope,
		Baseline: baseline, Genesis: genesis,
	}, nil
}

func baselineProtectionParameters(value []byte) []byte {
	if len(value) == 0 {
		return nil
	}
	return append([]byte(nil), value...)
}

func sealInitialRecordEnvelope(vaultID, epochID [32]byte, epochKey, protection, payload []byte) (storage.OpaqueEnvelope, error) {
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
		VaultID: vaultID, KeyEpochID: epochID, KeyEpochKey: epochKey,
		PayloadType: 1, PayloadBytes: payload, ProtectionParameters: protection,
	})
	if err != nil {
		return storage.OpaqueEnvelope{}, err
	}
	return storage.DecodeOpaqueEnvelope(encoded)
}

func VerifyPreparedCreation(prepared PreparedCanonicalVaultCreation) bool {
	if !canonical.VerifyEventSignature(prepared.Genesis, ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey)) {
		return false
	}
	proofTranscript, err := canonical.Transcript("awsm:genesis-possession-proof:v1",
		prepared.IDs.VaultID[:], prepared.IDs.GenerationID[:], prepared.Baseline.RecordID[:], prepared.IDs.FirstMemberID[:],
		mustCanonical(prepared.ClientCertificate), mustCanonical(prepared.RecoveryCredential), prepared.KeyEpochID[:], prepared.RequiredFeatureSetID[:],
	)
	if err != nil {
		return false
	}
	body, ok := prepared.Genesis.Body.(canonical.Map)
	if !ok {
		return false
	}
	proof, ok := body[6].(canonical.Map)
	if !ok {
		return false
	}
	clientProof, clientOK := proof[0].([]byte)
	recoveryProof, recoveryOK := proof[1].([]byte)
	return clientOK && recoveryOK && ed25519.Verify(ed25519.PublicKey(prepared.ClientKeys.SigningPublicKey), proofTranscript, clientProof) &&
		ed25519.Verify(ed25519.PublicKey(prepared.RecoveryKeys.SigningPublicKey), proofTranscript, recoveryProof)
}

func creationIDs(supplied *CreationIDs) (CreationIDs, error) {
	if supplied != nil {
		ids := *supplied
		if ids.VaultID == ([32]byte{}) || ids.GenerationID == ([32]byte{}) || ids.FirstMemberID == ([32]byte{}) ||
			ids.ClientCredentialID == ([32]byte{}) || ids.RecoveryCredentialID == ([32]byte{}) || ids.LabelCauseID == ([32]byte{}) {
			return CreationIDs{}, errors.New("creation IDs must not be zero")
		}
		return ids, nil
	}
	var ids CreationIDs
	for _, target := range []*[32]byte{&ids.VaultID, &ids.GenerationID, &ids.FirstMemberID, &ids.ClientCredentialID, &ids.RecoveryCredentialID, &ids.LabelCauseID} {
		if _, err := io.ReadFull(cryptorand.Reader, target[:]); err != nil {
			return CreationIDs{}, fmt.Errorf("generate creation ID: %w", err)
		}
	}
	return ids, nil
}

func cloneLabel(label *string) canonical.Value {
	if label == nil {
		return nil
	}
	return *label
}

func valuesForLabel(label *string, causeID [32]byte) []canonical.Value {
	if label == nil {
		return []canonical.Value{}
	}
	return []canonical.Value{append([]byte(nil), causeID[:]...)}
}

func canonicalSetValues(values []canonical.Value) []canonical.Value {
	type entry struct {
		encoded []byte
		value   canonical.Value
	}
	entries := make([]entry, 0, len(values))
	for _, value := range values {
		encoded, err := canonical.EncodeValue(value)
		if err != nil {
			panic(err)
		}
		entries = append(entries, entry{encoded: encoded, value: value})
	}
	sort.Slice(entries, func(left, right int) bool { return bytes.Compare(entries[left].encoded, entries[right].encoded) < 0 })
	result := make([]canonical.Value, len(entries))
	for index, entry := range entries {
		result[index] = entry.value
	}
	return result
}

func mustCanonical(value canonical.Value) []byte {
	encoded, err := canonical.EncodeValue(value)
	if err != nil {
		panic(err)
	}
	return encoded
}
