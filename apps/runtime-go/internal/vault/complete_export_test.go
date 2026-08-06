package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/completeexport"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/store"
)

func TestRuntimeExportsCanonicalCompleteExportClosure(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Portable")
	const passphrase = "correct horse battery staple"

	encrypted, err := runtime.ExportComplete(vaultID, passphrase)
	if err != nil {
		t.Fatalf("export Complete Export: %v", err)
	}
	opened, err := completeexport.OpenStream(passphrase, encrypted)
	if err != nil {
		t.Fatalf("open Complete Export: %v", err)
	}
	entries, err := decodeCompleteExportEntries(opened.Plaintext)
	if err != nil {
		t.Fatalf("decode Complete Export entries: %v", err)
	}
	if got := []uint64{entries[0].Header.Kind, entries[1].Header.Kind, entries[2].Header.Kind, entries[3].Header.Kind, entries[4].Header.Kind, entries[5].Header.Kind}; !bytes.Equal([]byte{byte(got[0]), byte(got[1]), byte(got[2]), byte(got[3]), byte(got[4]), byte(got[5])}, []byte{1, 2, 2, 2, 2, 3}) {
		t.Fatalf("Complete Export entry kinds = %v, want [1 2 2 2 2 3]", got)
	}
	manifest, err := completeexport.DecodeManifest(entries[0].Bytes)
	if err != nil {
		t.Fatalf("decode Complete Export Manifest: %v", err)
	}
	vaultIdentifier, err := decodeHexIdentifier(vaultID)
	if err != nil {
		t.Fatalf("decode Vault ID: %v", err)
	}
	if manifest.VaultID != vaultIdentifier || len(manifest.TypedLogicalRoots) != 2 || len(manifest.OpaqueItemInventory) != 4 {
		t.Fatalf("Complete Export Manifest = %#v", manifest)
	}
	keyInventory, err := completeexport.DecodeKeyInventory(entries[len(entries)-1].Bytes)
	if err != nil {
		t.Fatalf("decode Complete Export Key Inventory: %v", err)
	}
	if len(keyInventory.Entries) != 1 || keyInventory.VaultID != vaultIdentifier {
		t.Fatalf("Complete Export Key Inventory = %#v", keyInventory)
	}
}

func TestRuntimeImportsCompleteExportAsAuthoringFreeReplica(t *testing.T) {
	ctx := context.Background()
	sourceDependencies := memoryDependencies(t)
	source, err := New(ctx, store.NewMemoryState(), sourceDependencies)
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Imported")
	complete, err := source.ExportComplete(vaultID, phrase)
	if err != nil {
		t.Fatalf("export Complete Export: %v", err)
	}

	destinationDependencies := memoryDependencies(t)
	destinationState := store.NewMemoryState()
	destination, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	state, err := destination.ImportComplete(ctx, phrase, complete)
	if err != nil {
		t.Fatalf("import Complete Export: %v", err)
	}
	if len(state.Vaults) != 1 || state.Vaults[0].VaultID != vaultID || state.Vaults[0].Access != "ReadOnly" {
		t.Fatalf("imported Client state = %#v", state)
	}
	if destination.replicas[vaultID] == nil {
		t.Fatal("Complete Import did not install an authenticated Replica")
	}
	if _, err := destinationDependencies.Secrets.Get(trustedSecretService, clientSecretAccount(vaultID, destination.vaults[vaultID].Canonical.ClientCredentialID)); err == nil {
		t.Fatal("Complete Import retained a Client Credential private key")
	}
	restarted, err := New(ctx, destinationState, destinationDependencies)
	if err != nil {
		t.Fatalf("restart imported Runtime: %v", err)
	}
	if restarted.replicas[vaultID] == nil || restarted.State().Vaults[0].Access != "ReadOnly" {
		t.Fatalf("restarted imported state = %#v", restarted.State())
	}
}

func TestRuntimeCommandsExposeCompleteExportAndImport(t *testing.T) {
	ctx := context.Background()
	source, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create source Runtime: %v", err)
	}
	vaultID, phrase := createVaultWithPhraseForTest(t, source, "Command Export")
	result, err := source.Handle(ctx, mustJSON(map[string]any{
		"type": "ExportComplete", "expectedVaultId": vaultID, "passphrase": phrase,
	}))
	if err != nil {
		t.Fatalf("ExportComplete command: %v", err)
	}
	packageValue, ok := result.(map[string]string)
	if !ok || packageValue["package"] == "" {
		t.Fatalf("ExportComplete command result = %#v", result)
	}
	complete, err := base64.RawURLEncoding.DecodeString(packageValue["package"])
	if err != nil {
		t.Fatalf("decode ExportComplete command package: %v", err)
	}
	destination, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create destination Runtime: %v", err)
	}
	importResult, err := destination.Handle(ctx, mustJSON(map[string]any{
		"type": "ImportComplete", "passphrase": phrase, "package": base64.RawURLEncoding.EncodeToString(complete),
	}))
	if err != nil {
		t.Fatalf("ImportComplete command: %v", err)
	}
	encodedState, err := json.Marshal(importResult)
	if err != nil || !bytes.Contains(encodedState, []byte(vaultID)) {
		t.Fatalf("ImportComplete command result = %s, %v", encodedState, err)
	}
}

func TestRuntimeCompleteExportRejectsUnverifiedStreamableArtifact(t *testing.T) {
	ctx := context.Background()
	runtime, err := New(ctx, store.NewMemoryState(), memoryDependencies(t))
	if err != nil {
		t.Fatalf("create Runtime: %v", err)
	}
	vaultID := createVaultForTest(t, runtime, "Streamable rejection")
	streamPayload := make([]byte, 9+int(storage.FrameTagLength))
	streamPayload[4] = 1 // final frame
	streamPayload[5] = 0
	streamPayload[6] = 0
	streamPayload[7] = 0
	streamPayload[8] = byte(storage.FrameTagLength)
	encoded, err := storage.EncodeOpaqueEnvelope(storage.OpaqueEnvelopeInput{
		StorageClass:         storage.StreamableStorageClass,
		ProtectionParameters: make([]byte, 64),
		Payload:              streamPayload,
	})
	if err != nil {
		t.Fatalf("encode Streamable wrapper: %v", err)
	}
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("decode Streamable wrapper: %v", err)
	}
	if err := runtime.deps.Artifacts.Put(hexIdentifier(envelope.StorageItemID), bytes.NewReader(encoded)); err != nil {
		t.Fatalf("store Streamable wrapper: %v", err)
	}
	artifactID := filledCreationID(240)
	runtime.vaults[vaultID].Canonical.ArtifactStorageItemIDs[hexIdentifier(artifactID)] = hexIdentifier(envelope.StorageItemID)

	_, err = runtime.ExportComplete(vaultID, "correct horse battery staple")
	var commandErr *CommandError
	if !errors.As(err, &commandErr) || commandErr.ID != "COMPLETE_EXPORT_UNAVAILABLE" {
		t.Fatalf("ExportComplete error = %v, want COMPLETE_EXPORT_UNAVAILABLE", err)
	}
}

func decodeCompleteExportEntries(plaintext []byte) ([]completeexport.Entry, error) {
	entries := make([]completeexport.Entry, 0)
	for offset := 0; offset < len(plaintext); {
		if len(plaintext)-offset < 4 {
			return nil, errCompleteExportEntriesTruncated
		}
		headerLength := int(binary.BigEndian.Uint32(plaintext[offset : offset+4]))
		offset += 4
		if headerLength < 1 || len(plaintext)-offset < headerLength {
			return nil, errCompleteExportEntriesTruncated
		}
		header, err := completeexport.DecodeEntryHeader(plaintext[offset : offset+headerLength])
		if err != nil {
			return nil, err
		}
		offset += headerLength
		if uint64(len(plaintext)-offset) < header.ByteLength {
			return nil, errCompleteExportEntriesTruncated
		}
		body := append([]byte(nil), plaintext[offset:offset+int(header.ByteLength)]...)
		offset += int(header.ByteLength)
		entries = append(entries, completeexport.Entry{Header: header, Bytes: body})
	}
	return entries, nil
}

var errCompleteExportEntriesTruncated = &completeExportEntriesError{}

type completeExportEntriesError struct{}

func (*completeExportEntriesError) Error() string { return "Complete Export entries are truncated" }
