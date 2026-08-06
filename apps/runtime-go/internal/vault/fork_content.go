package vault

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

// reauthorForkContentEvents carries the deliberately small first Fork slice:
// a content label has no object or authority dependencies, so it can be
// signed again against the destination Genesis without importing source
// history. More involved content closures fail closed until their identity and
// heavy-wrapper mappings are implemented.
func reauthorForkContentEvents(
	source *Replica,
	destination *Replica,
	creation PreparedCanonicalVaultCreation,
	state *canonicalReplicaState,
	artifacts Dependencies,
) error {
	if source == nil || destination == nil || state == nil || artifacts.Artifacts == nil {
		return errors.New("Fork content preparation is unavailable")
	}
	if len(source.objects) != 0 {
		return errors.New("Fork Object and Artifact re-authoring is not implemented by this Runtime")
	}
	content := make([]canonical.Event, 0)
	for _, event := range source.Events() {
		if event.Family == canonical.ContentFamily {
			if event.Type != 1 || len(event.Dependencies) != 0 {
				return fmt.Errorf("Fork Content Event type %d re-authoring is not implemented by this Runtime", event.Type)
			}
			content = append(content, event)
		}
	}
	if len(content) == 0 {
		return nil
	}
	sort.Slice(content, func(left, right int) bool {
		return bytes.Compare(content[left].RecordID[:], content[right].RecordID[:]) < 0
	})
	translated := make(map[canonical.Identifier]canonical.Identifier, len(content))
	stored := make([]string, 0, len(content))
	cleanup := func() {
		for _, storageItemID := range stored {
			_ = artifacts.Artifacts.Delete(storageItemID)
		}
	}
	for len(content) > 0 {
		progress := false
		for index := 0; index < len(content); index++ {
			sourceEvent := content[index]
			parents := make([]canonical.Identifier, 0, len(sourceEvent.ParentRecordIDs)+1)
			ready := true
			for _, parent := range sourceEvent.ParentRecordIDs {
				if mapped, ok := translated[parent]; ok {
					parents = append(parents, mapped)
					continue
				}
				if parent == source.genesisID {
					parents = append(parents, creation.Genesis.RecordID)
					continue
				}
				// Authority and lifecycle ancestry is intentionally not copied
				// into a state-only Fork; the fresh Genesis is the authority root.
				if record, ok := source.Record(parent); ok && record.Event != nil &&
					record.Event.Family != canonical.ContentFamily {
					parents = append(parents, creation.Genesis.RecordID)
					continue
				}
				ready = false
				break
			}
			if !ready {
				continue
			}
			parents = append(parents, creation.Genesis.RecordID)
			parents = sortUniqueIdentifiers(parents)
			authorityParents := []canonical.Identifier{creation.Genesis.RecordID}
			event, err := canonical.SignEvent(canonical.EventInput{
				VaultID: creation.IDs.VaultID, GenerationID: creation.IDs.GenerationID,
				ParentRecordIDs: parents, AuthorityParentIDs: authorityParents,
				Dependencies: []canonical.Dependency{}, RequiredFeatureSetID: creation.RequiredFeatureSetID,
				Extensions: cloneEventExtensions(sourceEvent.Extensions), Family: canonical.ContentFamily,
				Type: sourceEvent.Type, SignerCredentialID: creation.IDs.ClientCredentialID,
				AssertedAt: sourceEvent.AssertedAt, Body: sourceEvent.Body,
			}, ed25519.PrivateKey(creation.ClientKeys.SigningSecretKey))
			if err != nil {
				cleanup()
				return fmt.Errorf("sign Fork Content Event: %w", err)
			}
			encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
				VaultID: creation.IDs.VaultID, KeyEpochID: creation.KeyEpochID,
				KeyEpochKey: creation.KeyEpochKey, PayloadType: 1, PayloadBytes: event.Bytes,
			})
			if err != nil {
				cleanup()
				return fmt.Errorf("protect Fork Content Event: %w", err)
			}
			envelope, err := storage.DecodeOpaqueEnvelope(encoded)
			if err != nil {
				cleanup()
				return fmt.Errorf("decode Fork Content Event envelope: %w", err)
			}
			if err := storeOpaqueCreationItem(artifacts.Artifacts, envelope.StorageItemID, encoded); err != nil {
				cleanup()
				return fmt.Errorf("store Fork Content Event: %w", err)
			}
			storageItemID := hexIdentifier(envelope.StorageItemID)
			stored = append(stored, storageItemID)
			state.RecordStorageItemIDs[hexIdentifier(event.RecordID)] = storageItemID
			if err := destination.AdmitEvent(event, ed25519.PublicKey(creation.ClientKeys.SigningPublicKey)); err != nil {
				cleanup()
				return fmt.Errorf("admit Fork Content Event: %w", err)
			}
			translated[sourceEvent.RecordID] = event.RecordID
			content = append(content[:index], content[index+1:]...)
			index--
			progress = true
		}
		if !progress {
			cleanup()
			return errors.New("Fork Content Event graph cannot reach the fresh Genesis")
		}
	}
	next := destination.State()
	state.CausalFrontier = identifiersToHex(next.CausalFrontier)
	state.AuthorityFrontier = identifiersToHex(next.AuthorityFrontier)
	state.ContinuityRecordIDs = identifiersToHex(next.ContinuityRecordIDs)
	return nil
}

func cloneEventExtensions(values map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(values))
	for key, value := range values {
		result[key] = append([]byte(nil), value...)
	}
	return result
}
