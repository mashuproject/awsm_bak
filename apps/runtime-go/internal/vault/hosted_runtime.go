package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

type hostedMaterializationTarget struct {
	namespace   byte
	logicalID   [32]byte
	payloadType uint64
	epochID     [32]byte
	encoded     []byte
}

func (r *Runtime) beginHostedReplicaAttachment(ctx context.Context, id, endpoint, name, username, password string) (any, error) {
	_ = ctx
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	if _, err := r.vaultLocked(id); err != nil {
		return nil, err
	}
	if r.pending != nil || r.hostedAttachment != nil {
		return nil, commandError("VAULT_SETUP_PENDING", "Finish or cancel the existing Vault setup first.")
	}
	if err := validateEndpoint(endpoint); err != nil {
		return nil, err
	}
	if len(name) < 1 || len(name) > 256 || len(username) < 1 || len(username) > 256 || len(password) < 1 || len(password) > 1_024 {
		return nil, commandError("REMOTE_CREDENTIAL_INVALID", "Hosted Replica credentials are invalid.")
	}
	session, err := signInHostedReplica(ctx, endpoint, username, password, r.deps.HTTPClient)
	if err != nil || session.Username != username {
		return nil, commandError("REMOTE_AUTHENTICATION_FAILED", "Hosted Replica sign-in failed.")
	}
	host, err := newHostedReplicaHTTP(endpoint, session.AccessToken, r.deps.HTTPClient)
	if err != nil {
		return nil, commandError("REMOTE_ENDPOINT_INVALID", "Hosted Replica endpoint is invalid.")
	}
	replicas, err := host.listReplicas(ctx)
	if err != nil {
		return nil, commandError("REMOTE_LIST_FAILED", "The Hosted Replica list could not be read.")
	}
	usable := make([]hostedReplicaSummary, 0, len(replicas))
	for _, replica := range replicas {
		if hasHostedReplicaSyncCapabilities(replica.Capabilities) {
			usable = append(usable, replica)
		}
	}
	sort.Slice(usable, func(left, right int) bool { return usable[left].ReplicaHandle < usable[right].ReplicaHandle })
	if len(usable) == 0 {
		return nil, commandError("REMOTE_REPLICA_NOT_FOUND", "This Account has no Hosted Replica with full synchronization access.")
	}
	setup := &pendingHostedAttachment{
		SetupID:         uuid.NewString(),
		ExpectedVaultID: id,
		Endpoint:        endpoint,
		Name:            name,
		Session:         session,
		Replicas:        usable,
	}
	r.hostedAttachment = setup
	candidates := make([]map[string]any, 0, len(usable))
	for _, replica := range usable {
		candidates = append(candidates, map[string]any{"replicaHandle": replica.ReplicaHandle, "storedBytes": replica.StoredBytes})
	}
	return map[string]any{"setupId": setup.SetupID, "replicas": candidates}, nil
}

func (r *Runtime) confirmHostedReplicaAttachment(ctx context.Context, id, setupID, replicaHandle string) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.requireExpectedLocked(&id); err != nil {
		return nil, err
	}
	setup := r.hostedAttachment
	if setup == nil || setup.SetupID != setupID {
		return nil, commandError("SETUP_NOT_FOUND", "The Hosted Replica attachment setup was not found.")
	}
	if setup.ExpectedVaultID != id {
		return nil, commandError("VAULT_CONTEXT_CHANGED", "The selected Vault changed.")
	}
	var selected hostedReplicaSummary
	found := false
	for _, candidate := range setup.Replicas {
		if candidate.ReplicaHandle == replicaHandle {
			selected = candidate
			found = true
			break
		}
	}
	if !found {
		return nil, commandError("REMOTE_REPLICA_NOT_FOUND", "The selected Hosted Replica was not found.")
	}
	if r.deps.Secrets == nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "This Client cannot retain a Hosted Replica session.")
	}
	value, err := r.vaultLocked(id)
	if err != nil {
		return nil, err
	}
	remoteID := uuid.NewString()
	remote := remoteState{
		RemoteID: remoteID, Name: setup.Name, Endpoint: setup.Endpoint, Enabled: true,
		ReplicaHandle: selected.ReplicaHandle, LocatorSalt: hex.EncodeToString(selected.LocatorSalt[:]), InventoryPageSize: 100,
	}
	before := r.snapshotLocked()
	if err := r.deps.Secrets.Put(trustedSecretService, remoteSessionAccount(remoteID), mustEncodeHostedSession(setup.Session)); err != nil {
		return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "The Hosted Replica session could not be stored.")
	}
	value.Remotes = append(value.Remotes, remote)
	r.hostedAttachment = nil
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		_ = r.deps.Secrets.Delete(trustedSecretService, remoteSessionAccount(remoteID))
		return nil, err
	}
	r.signal()
	return RemoteSummary{RemoteID: remoteID, Name: remote.Name, Endpoint: remote.Endpoint, Enabled: true, ReplicaHandle: remote.ReplicaHandle}, nil
}

func (r *Runtime) cancelHostedReplicaAttachment(setupID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.hostedAttachment == nil || r.hostedAttachment.SetupID != setupID {
		return commandError("SETUP_NOT_FOUND", "The Hosted Replica attachment setup was not found.")
	}
	r.hostedAttachment = nil
	return nil
}

func (r *Runtime) hostedHTTP(ctx context.Context, remote remoteState) (*hostedReplicaHTTP, error) {
	if r.deps.Secrets == nil {
		return nil, errors.New("secure session storage is unavailable")
	}
	encoded, err := r.deps.Secrets.Get(trustedSecretService, remoteSessionAccount(remote.RemoteID))
	if err != nil {
		return nil, err
	}
	session, err := decodeHostedSession(encoded)
	if err != nil {
		return nil, err
	}
	if session.AccessExpiresAt <= time.Now().UnixMilli()+5_000 {
		if session.RefreshToken == "" {
			return nil, errors.New("Hosted Replica session has expired")
		}
		refreshed, refreshErr := refreshHostedReplica(ctx, remote.Endpoint, session.RefreshToken, r.deps.HTTPClient)
		if refreshErr != nil || refreshed.Username != session.Username {
			return nil, errors.New("Hosted Replica session refresh failed")
		}
		session = refreshed
		if err := r.deps.Secrets.Put(trustedSecretService, remoteSessionAccount(remote.RemoteID), mustEncodeHostedSession(session)); err != nil {
			return nil, err
		}
	}
	return newHostedReplicaHTTP(remote.Endpoint, session.AccessToken, r.deps.HTTPClient)
}

func (r *Runtime) materializeHostedReplica(ctx context.Context, id, remoteID string) (any, error) {
	r.mu.RLock()
	if err := r.requireExpectedLocked(&id); err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	value, err := r.vaultLockedRead(id)
	if err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	var remote remoteState
	found := false
	for _, candidate := range value.Remotes {
		if candidate.RemoteID == remoteID {
			remote = candidate
			found = true
			break
		}
	}
	if !found {
		r.mu.RUnlock()
		return nil, commandError("REMOTE_NOT_FOUND", "The Hosted Replica was not found.")
	}
	if !remote.Enabled {
		r.mu.RUnlock()
		return nil, commandError("REMOTE_DISABLED", "The Hosted Replica is disabled on this Client.")
	}
	if value.Canonical == nil || r.deps.Artifacts == nil || r.deps.Secrets == nil || r.replicas[id] == nil {
		r.mu.RUnlock()
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	canonicalState := cloneCanonicalState(value.Canonical)
	targets, err := r.materializationTargetsLocked(canonicalState)
	r.mu.RUnlock()
	if err != nil {
		return nil, err
	}
	host, err := r.hostedHTTP(ctx, remote)
	if err != nil {
		return nil, commandError("REMOTE_AUTHENTICATION_FAILED", "The Hosted Replica session is unavailable.")
	}
	locatorSalt, err := decodeDigest(remote.LocatorSalt)
	if err != nil {
		return nil, commandError("REMOTE_CONFIGURATION_INVALID", "The Hosted Replica locator configuration is invalid.")
	}
	vaultIdentifier, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	materialized, alreadyPresent := 0, 0
	for _, target := range targets {
		locator, err := deriveHostedReplicaLocator(locatorSalt, target.namespace, target.logicalID)
		if err != nil {
			return nil, commandError("REMOTE_CONFIGURATION_INVALID", "The Hosted Replica locator configuration is invalid.")
		}
		encoded := target.encoded
		if target.payloadType == 1 || target.payloadType == 2 || target.payloadType == 3 {
			epochBytes, epochErr := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(id, hexIdentifier(target.epochID)))
			if epochErr != nil {
				return nil, commandError("TRUSTED_SECRET_UNAVAILABLE", "A required Key Epoch could not be opened.")
			}
			epochSecret, epochErr := decodeEpochSecret(epochBytes, vaultIdentifier, target.epochID)
			if epochErr != nil {
				return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "A required Key Epoch is invalid.")
			}
			opened, openErr := awsmcrypto.OpenCompactItem(vaultIdentifier, target.epochID, epochSecret.key, encoded)
			if openErr != nil {
				zeroBytes(epochSecret.key)
				return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Compact item could not be opened.")
			}
			encoded, err = awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{
				VaultID: vaultIdentifier, KeyEpochID: target.epochID, KeyEpochKey: epochSecret.key,
				PayloadType: opened.PayloadType, PayloadBytes: opened.PayloadBytes,
			})
			zeroBytes(epochSecret.key)
			if err != nil {
				return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Compact item could not be rewrapped.")
			}
		}
		admission, err := host.admitCompact(ctx, remote.ReplicaHandle, locator, encoded)
		if err != nil {
			return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "The Hosted Replica rejected an opaque item.")
		}
		if admission.Admission == "already_present" {
			alreadyPresent++
		} else {
			materialized++
		}
	}
	return map[string]any{
		"remoteId": remoteID, "materializedCompactItemCount": materialized,
		"retriedCompactItemCount": 0, "alreadyConfirmedCompactItemCount": alreadyPresent,
	}, nil
}

func (r *Runtime) materializationTargetsLocked(state *canonicalReplicaState) ([]hostedMaterializationTarget, error) {
	if state == nil || r.replicas[state.VaultID] == nil {
		return nil, errors.New("Hosted materialization requires an authenticated Replica")
	}
	vaultIdentifier, err := decodeHexIdentifier(state.VaultID)
	if err != nil {
		return nil, err
	}
	targets := make([]hostedMaterializationTarget, 0, len(state.RecordStorageItemIDs)+len(state.ObjectStorageItemIDs)+2)
	authority, err := replayReplicaAuthorityState(r.replicas[state.VaultID], nil, nil)
	if err != nil {
		return nil, err
	}
	appendItem := func(namespace byte, logicalIDText, storageItemID string) error {
		logicalID, err := decodeHexIdentifier(logicalIDText)
		if err != nil {
			return err
		}
		reader, err := r.deps.Artifacts.Open(storageItemID)
		if err != nil {
			return err
		}
		encoded, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			return readErr
		}
		envelope, err := storage.DecodeOpaqueEnvelope(encoded)
		if err != nil || envelope.StorageClass != storage.CompactStorageClass {
			return errors.New("Hosted materialization requires Compact local items")
		}
		epochIDText, ok := state.StorageItemKeyEpochIDs[storageItemID]
		if !ok || !validDigest(epochIDText) {
			return errors.New("Hosted materialization requires a Storage Item Key Epoch binding")
		}
		epochID, err := decodeHexIdentifier(epochIDText)
		if err != nil {
			return err
		}
		payloadType := uint64(0)
		if namespace == hostedNamespaceRecord {
			payloadType = 1
		} else if namespace == hostedNamespaceObject {
			payloadType = 2
		} else if namespace == hostedNamespaceFeatureSet {
			payloadType = 3
		}
		targets = append(targets, hostedMaterializationTarget{namespace: namespace, logicalID: logicalID, payloadType: payloadType, epochID: epochID, encoded: encoded})
		return nil
	}
	appendKeyEnvelope := func(logicalIDText, storageItemID string) error {
		logicalID, err := decodeHexIdentifier(logicalIDText)
		if err != nil {
			return err
		}
		reader, err := r.deps.Artifacts.Open(storageItemID)
		if err != nil {
			return err
		}
		encoded, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			return readErr
		}
		envelope, err := storage.DecodeOpaqueEnvelope(encoded)
		if err != nil || envelope.StorageClass != storage.CompactStorageClass || hexIdentifier(envelope.StorageItemID) != storageItemID {
			return errors.New("Hosted materialization requires a valid Key Envelope")
		}
		epochIDText, ok := state.StorageItemKeyEpochIDs[storageItemID]
		if !ok || !validDigest(epochIDText) {
			return errors.New("Hosted materialization requires a Key Envelope Key Epoch binding")
		}
		epochID, err := decodeHexIdentifier(epochIDText)
		if err != nil {
			return err
		}
		var slot keyEpochEnvelopeSlot
		found := false
		for candidateEpochID, slots := range authority.epochSlots {
			for _, candidate := range slots {
				if candidate.envelopeID == logicalID {
					slot = candidate
					if candidateEpochID != epochID {
						return errors.New("Hosted materialization Key Envelope Epoch binding is invalid")
					}
					found = true
					break
				}
			}
			if found {
				break
			}
		}
		if !found {
			return errors.New("Hosted materialization Key Envelope is not named by authenticated Authority")
		}
		epochSecretBytes, err := r.deps.Secrets.Get(trustedSecretService, epochSecretAccount(state.VaultID, epochIDText))
		if err != nil {
			return err
		}
		epochSecret, err := decodeEpochSecret(epochSecretBytes, vaultIdentifier, epochID)
		if err != nil {
			return err
		}
		defer zeroBytes(epochSecret.key)
		var wrappingPublicKey []byte
		switch slot.targetKind {
		case awsmcrypto.ClientCredentialTarget:
			descriptor, ok := authority.clientCertificates[slot.targetID]
			if !ok || slot.targetRevision != nil || len(descriptor.wrappingKey) != 32 {
				return errors.New("Hosted materialization Client Key Envelope target is unavailable")
			}
			wrappingPublicKey = descriptor.wrappingKey
		case awsmcrypto.RecoveryCredentialTarget:
			descriptor, ok := authority.recoveryCredentials[slot.targetID]
			if !ok || slot.targetRevision == nil || descriptor.revision != *slot.targetRevision || len(descriptor.wrappingKey) != 32 {
				return errors.New("Hosted materialization Recovery Key Envelope target is unavailable")
			}
			wrappingPublicKey = descriptor.wrappingKey
		default:
			return errors.New("Hosted materialization Key Envelope target kind is invalid")
		}
		sealed, err := awsmcrypto.SealKeyEnvelope(awsmcrypto.KeyEnvelopeInput{
			VaultID: vaultIdentifier, KeyEpochID: epochID, KeyEpochKey: epochSecret.key,
			TargetKind: slot.targetKind, TargetCredentialID: slot.targetID, TargetRevision: slot.targetRevision,
			RecipientWrappingPublicKey: wrappingPublicKey,
		})
		if err != nil || sealed.ID != logicalID {
			return errors.New("Hosted materialization Key Envelope logical identity changed")
		}
		targets = append(targets, hostedMaterializationTarget{namespace: hostedNamespaceKeyEnvelope, logicalID: logicalID, epochID: epochID, encoded: sealed.Envelope.Bytes})
		return nil
	}
	for logicalID, storageItemID := range state.RecordStorageItemIDs {
		if err := appendItem(hostedNamespaceRecord, logicalID, storageItemID); err != nil {
			return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Vault Record could not be opened.")
		}
	}
	for logicalID, storageItemID := range state.KeyEnvelopeStorageItemIDs {
		if err := appendKeyEnvelope(logicalID, storageItemID); err != nil {
			return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Key Envelope could not be opened.")
		}
	}
	for logicalID, storageItemID := range state.ObjectStorageItemIDs {
		if err := appendItem(hostedNamespaceObject, logicalID, storageItemID); err != nil {
			return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Vault Object could not be opened.")
		}
	}
	for logicalID, storageItemID := range state.FeatureManifestStorageItemIDs {
		if err := appendItem(hostedNamespaceFeatureSet, logicalID, storageItemID); err != nil {
			return nil, commandError("REMOTE_MATERIALIZATION_FAILED", "A local Feature Manifest could not be opened.")
		}
	}
	sort.Slice(targets, func(left, right int) bool {
		if targets[left].namespace != targets[right].namespace {
			return targets[left].namespace < targets[right].namespace
		}
		return bytes.Compare(targets[left].logicalID[:], targets[right].logicalID[:]) < 0
	})
	return targets, nil
}

func (r *Runtime) pullHostedReplicas(ctx context.Context, id string) (any, error) {
	if err := r.promoteHostedQuarantine(ctx, id); err != nil {
		return nil, err
	}
	r.mu.RLock()
	if err := r.requireExpectedLocked(&id); err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	value, err := r.vaultLockedRead(id)
	if err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	remotes := append([]remoteState(nil), value.Remotes...)
	canonicalState := cloneCanonicalState(value.Canonical)
	r.mu.RUnlock()
	if canonicalState == nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	vaultID, err := decodeHexIdentifier(id)
	if err != nil {
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The Vault identity is invalid.")
	}
	sort.Slice(remotes, func(left, right int) bool { return remotes[left].RemoteID < remotes[right].RemoteID })
	results := make([]map[string]string, 0, len(remotes))
	for _, remote := range remotes {
		result := map[string]string{"remoteId": remote.RemoteID, "status": "Completed"}
		if !remote.Enabled {
			result["status"] = "Disabled"
			results = append(results, result)
			continue
		}
		host, hostErr := r.hostedHTTP(ctx, remote)
		if hostErr != nil {
			result["status"] = "Failed"
			results = append(results, result)
			continue
		}
		var cursor *int64
		var position *[32]byte
		seenPositions := make(map[[32]byte]struct{})
		pendingBaselines := make(map[canonical.Identifier][]byte)
		pendingVacuumEvents := make(map[canonical.Identifier][]byte)
		failed := false
		for {
			page, pageErr := host.inventory(ctx, remote.ReplicaHandle, cursor, position, remote.InventoryPageSize)
			if pageErr != nil {
				failed = true
				break
			}
			if cursor == nil {
				value := page.SnapshotCursor
				cursor = &value
			} else if *cursor != page.SnapshotCursor {
				failed = true
				break
			}
			for _, item := range page.Items {
				if item.StorageClass != storage.CompactStorageClass {
					continue
				}
				encoded, itemErr := host.item(ctx, remote.ReplicaHandle, item.StorageItemID, item.ByteLength)
				if itemErr != nil {
					failed = true
					break
				}
				envelope, envelopeErr := storage.DecodeOpaqueEnvelope(encoded)
				if envelopeErr != nil || envelope.StorageItemID != item.StorageItemID || envelope.CiphertextDigest != item.CipherDigest {
					continue
				}
				opened, openErr := r.openOpaqueWithKnownEpochs(id, canonicalState, vaultID, encoded)
				if openErr != nil {
					if admitErr := r.AdmitOpaqueKeyEnvelope(ctx, id, encoded); admitErr == nil {
						continue
					}
					if quarantineErr := r.quarantineHostedItem(ctx, id, encoded); quarantineErr != nil {
						failed = true
						break
					}
					continue
				}
				switch opened.PayloadType {
				case 1:
					if baseline, baselineErr := canonical.DecodeBaseline(opened.PayloadBytes); baselineErr == nil {
						r.mu.RLock()
						current := r.vaults[id]
						currentReplica := r.replicas[id]
						var generationID canonical.Identifier
						var generationErr error
						if current != nil {
							generationID, generationErr = decodeHexIdentifier(current.GenerationID)
						}
						matches := current != nil && current.Canonical != nil && generationErr == nil && baseline.VaultID == vaultID && baseline.GenerationID == generationID && hexIdentifier(baseline.RecordID) == current.Canonical.BaselineID
						known := currentReplica != nil
						if known {
							_, known = currentReplica.Record(baseline.RecordID)
						}
						r.mu.RUnlock()
						if matches || known {
							continue
						}
						if baseline.VaultID != vaultID || generationErr != nil {
							failed = true
							break
						}
						pendingBaselines[baseline.RecordID] = append([]byte(nil), encoded...)
						if eventEncoded, waiting := pendingVacuumEvents[baseline.RecordID]; waiting {
							if admitErr := r.admitOpaqueVacuum(ctx, id, encoded, eventEncoded); admitErr != nil {
								failed = true
								break
							}
							delete(pendingVacuumEvents, baseline.RecordID)
							delete(pendingBaselines, baseline.RecordID)
						}
					} else {
						event, eventErr := canonical.DecodeEvent(opened.PayloadBytes)
						if eventErr != nil {
							failed = true
							break
						}
						r.mu.RLock()
						currentReplica := r.replicas[id]
						current := r.vaults[id]
						known := currentReplica != nil
						if known {
							_, known = currentReplica.Record(event.RecordID)
						}
						var currentGeneration canonical.Identifier
						var generationErr error
						if current != nil {
							currentGeneration, generationErr = decodeHexIdentifier(current.GenerationID)
						}
						r.mu.RUnlock()
						if known {
							continue
						}
						if event.Family == canonical.LifecycleFamily && event.Type == 1 {
							var successorBaselineID canonical.Identifier
							for _, dependency := range event.Dependencies {
								if dependency.Type == 2 {
									successorBaselineID = dependency.ID
									break
								}
							}
							if successorBaselineID == (canonical.Identifier{}) {
								failed = true
								break
							}
							if baselineEncoded, waiting := pendingBaselines[successorBaselineID]; waiting {
								if admitErr := r.admitOpaqueVacuum(ctx, id, baselineEncoded, encoded); admitErr != nil {
									failed = true
									break
								}
								delete(pendingBaselines, successorBaselineID)
							} else {
								pendingVacuumEvents[successorBaselineID] = append([]byte(nil), encoded...)
							}
							continue
						}
						if generationErr != nil || event.GenerationID != currentGeneration {
							failed = true
							break
						}
						if admitErr := r.AdmitOpaqueEvent(ctx, id, encoded); admitErr != nil {
							failed = true
							break
						}
					}
				case 2:
					if admitErr := r.AdmitOpaqueObject(ctx, id, encoded); admitErr != nil {
						failed = true
					}
				case 3:
					if admitErr := r.AdmitOpaqueFeatureManifest(ctx, id, encoded); admitErr != nil {
						failed = true
					}
				default:
					failed = true
				}
				if failed {
					break
				}
			}
			if failed || page.NextPosition == nil {
				break
			}
			if _, duplicate := seenPositions[*page.NextPosition]; duplicate {
				failed = true
				break
			}
			seenPositions[*page.NextPosition] = struct{}{}
			next := *page.NextPosition
			position = &next
		}
		if !failed {
			for successorBaselineID, eventEncoded := range pendingVacuumEvents {
				baselineEncoded, ok := pendingBaselines[successorBaselineID]
				if !ok || r.admitOpaqueVacuum(ctx, id, baselineEncoded, eventEncoded) != nil {
					failed = true
					break
				}
				delete(pendingBaselines, successorBaselineID)
			}
		}
		if !failed && len(pendingBaselines) != 0 {
			failed = true
		}
		if failed {
			result["status"] = "Failed"
		}
		results = append(results, result)
	}
	return results, nil
}

// quarantineHostedItem retains a verified opaque envelope when the local
// Client cannot yet open it with any available Key Epoch. Quarantine is local
// Execution State: it is not a Vault mapping, does not advance a Frontier, and
// survives Runtime restart until a later authenticated promotion can consume
// it.
func (r *Runtime) quarantineHostedItem(ctx context.Context, vaultID string, encoded []byte) error {
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		return err
	}
	storageItemID := hexIdentifier(envelope.StorageItemID)
	r.mu.Lock()
	value, err := r.vaultLocked(vaultID)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if value.Quarantine != nil {
		if existing, ok := value.Quarantine[storageItemID]; ok && bytes.Equal(existing, encoded) {
			r.mu.Unlock()
			return nil
		}
	}
	before := r.snapshotLocked()
	if value.Quarantine == nil {
		value.Quarantine = make(map[string][]byte)
	}
	value.Quarantine[storageItemID] = append([]byte(nil), encoded...)
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		r.mu.Unlock()
		return err
	}
	r.mu.Unlock()
	r.signal()
	return nil
}

// promoteHostedQuarantine retries only locally retained opaque items whose
// Key Epoch is now available. Items that still cannot be opened, or whose
// authenticated DAG/content dependencies are not ready, remain quarantined.
// A successful admission removes exactly that local quarantine entry.
func (r *Runtime) promoteHostedQuarantine(ctx context.Context, vaultID string) error {
	r.mu.RLock()
	value, err := r.vaultLockedRead(vaultID)
	if err != nil {
		r.mu.RUnlock()
		return err
	}
	state := cloneCanonicalState(value.Canonical)
	quarantine := cloneQuarantine(value.Quarantine)
	vaultIdentifier, decodeErr := decodeHexIdentifier(vaultID)
	r.mu.RUnlock()
	if decodeErr != nil || state == nil || len(quarantine) == 0 {
		return nil
	}
	storageItemIDs := make([]string, 0, len(quarantine))
	for storageItemID := range quarantine {
		storageItemIDs = append(storageItemIDs, storageItemID)
	}
	sort.Strings(storageItemIDs)
	for _, storageItemID := range storageItemIDs {
		encoded := quarantine[storageItemID]
		if admitErr := r.AdmitOpaqueKeyEnvelope(ctx, vaultID, encoded); admitErr == nil {
			if err := r.removeHostedQuarantine(ctx, vaultID, storageItemID); err != nil {
				return err
			}
			continue
		}
		opened, openErr := r.openOpaqueWithKnownEpochs(vaultID, state, vaultIdentifier, encoded)
		if openErr != nil {
			continue
		}
		var admitErr error
		switch opened.PayloadType {
		case 1:
			event, eventErr := canonical.DecodeEvent(opened.PayloadBytes)
			if eventErr != nil {
				continue
			}
			r.mu.RLock()
			known := false
			if replica := r.replicas[vaultID]; replica != nil {
				_, known = replica.Record(event.RecordID)
			}
			r.mu.RUnlock()
			if known {
				admitErr = nil
			} else if event.Family == canonical.LifecycleFamily && event.Type == 1 {
				// Vacuum successors require their paired Baseline and
				// continuity proof; the pull pipeline owns that pairing.
				continue
			} else {
				admitErr = r.AdmitOpaqueEvent(ctx, vaultID, encoded)
			}
		case 2:
			admitErr = r.AdmitOpaqueObject(ctx, vaultID, encoded)
		case 3:
			admitErr = r.AdmitOpaqueFeatureManifest(ctx, vaultID, encoded)
		default:
			continue
		}
		if admitErr != nil {
			continue
		}
		if err := r.removeHostedQuarantine(ctx, vaultID, storageItemID); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) removeHostedQuarantine(ctx context.Context, vaultID, storageItemID string) error {
	r.mu.Lock()
	value, err := r.vaultLocked(vaultID)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	if _, ok := value.Quarantine[storageItemID]; !ok {
		r.mu.Unlock()
		return nil
	}
	before := r.snapshotLocked()
	delete(value.Quarantine, storageItemID)
	if len(value.Quarantine) == 0 {
		value.Quarantine = nil
	}
	if err := r.persistLocked(ctx); err != nil {
		r.restoreLocked(before)
		r.mu.Unlock()
		return err
	}
	r.mu.Unlock()
	r.signal()
	return nil
}

func (r *Runtime) hydrateArtifact(ctx context.Context, id, artifactIDText string) (any, error) {
	r.mu.RLock()
	if err := r.requireExpectedLocked(&id); err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	value, err := r.vaultLockedRead(id)
	if err != nil {
		r.mu.RUnlock()
		return nil, err
	}
	artifactID, err := decodeHexIdentifier(artifactIDText)
	if err != nil {
		r.mu.RUnlock()
		return nil, commandError("ARTIFACT_ID_INVALID", "The Artifact identity is invalid.")
	}
	if value.Canonical == nil || r.replicas[id] == nil || r.deps.Artifacts == nil {
		r.mu.RUnlock()
		return nil, commandError("VAULT_REPLAY_UNAVAILABLE", "The authenticated Vault Replica is unavailable.")
	}
	if storageItemID, ok := value.Canonical.ArtifactStorageItemIDs[artifactIDText]; ok {
		if _, openErr := r.deps.Artifacts.Open(storageItemID); openErr == nil {
			r.mu.RUnlock()
			return map[string]string{"artifactId": artifactIDText, "storageItemId": storageItemID, "remoteId": "local"}, nil
		}
	}
	if object, ok := r.replicas[id].Object(artifactID); !ok || object.ObjectType != 2 {
		r.mu.RUnlock()
		return nil, commandError("ARTIFACT_NOT_FOUND", "The selected Artifact is not an authenticated Vault Object.")
	}
	remotes := append([]remoteState(nil), value.Remotes...)
	r.mu.RUnlock()
	sort.Slice(remotes, func(left, right int) bool { return remotes[left].RemoteID < remotes[right].RemoteID })
	for _, remote := range remotes {
		if !remote.Enabled {
			continue
		}
		host, hostErr := r.hostedHTTP(ctx, remote)
		if hostErr != nil {
			continue
		}
		locatorSalt, saltErr := decodeDigest(remote.LocatorSalt)
		if saltErr != nil {
			continue
		}
		locator, locatorErr := deriveHostedReplicaLocator(locatorSalt, hostedNamespaceArtifact, artifactID)
		if locatorErr != nil {
			continue
		}
		var cursor *int64
		var position *[32]byte
		seenPositions := make(map[[32]byte]struct{})
		for {
			page, pageErr := host.inventory(ctx, remote.ReplicaHandle, cursor, position, remote.InventoryPageSize)
			if pageErr != nil {
				break
			}
			if cursor == nil {
				value := page.SnapshotCursor
				cursor = &value
			} else if *cursor != page.SnapshotCursor {
				break
			}
			for _, item := range page.Items {
				if item.StorageClass != storage.StreamableStorageClass || item.Locator != locator {
					continue
				}
				encoded, itemErr := host.item(ctx, remote.ReplicaHandle, item.StorageItemID, item.ByteLength)
				if itemErr != nil {
					continue
				}
				envelope, envelopeErr := storage.DecodeOpaqueEnvelope(encoded)
				if envelopeErr != nil || envelope.StorageClass != storage.StreamableStorageClass || envelope.StorageItemID != item.StorageItemID || envelope.CiphertextDigest != item.CipherDigest {
					continue
				}
				if err := r.deps.Artifacts.Put(hexIdentifier(envelope.StorageItemID), bytes.NewReader(encoded)); err != nil {
					continue
				}
				r.mu.Lock()
				before := r.snapshotLocked()
				current, currentErr := r.vaultLocked(id)
				if currentErr == nil && current.Canonical != nil {
					if current.Canonical.ArtifactStorageItemIDs == nil {
						current.Canonical.ArtifactStorageItemIDs = map[string]string{}
					}
					storageItemID := hexIdentifier(envelope.StorageItemID)
					current.Canonical.ArtifactStorageItemIDs[artifactIDText] = storageItemID
					currentEpochID, epochErr := decodeHexIdentifier(current.Canonical.KeyEpochID)
					if epochErr == nil {
						bindStorageItemKeyEpoch(current.Canonical, storageItemID, currentEpochID)
						currentErr = r.persistLocked(ctx)
					} else {
						currentErr = epochErr
					}
				} else if currentErr == nil {
					currentErr = errors.New("canonical Vault state is unavailable")
				}
				if currentErr != nil {
					r.restoreLocked(before)
					_ = r.deps.Artifacts.Delete(hexIdentifier(envelope.StorageItemID))
					r.mu.Unlock()
					continue
				}
				r.mu.Unlock()
				r.signal()
				return map[string]string{"artifactId": artifactIDText, "storageItemId": hexIdentifier(envelope.StorageItemID), "remoteId": remote.RemoteID}, nil
			}
			if page.NextPosition == nil {
				break
			}
			if _, duplicate := seenPositions[*page.NextPosition]; duplicate {
				break
			}
			seenPositions[*page.NextPosition] = struct{}{}
			next := *page.NextPosition
			position = &next
		}
	}
	return nil, commandError("ARTIFACT_REMOTE_UNAVAILABLE", "No configured Hosted Replica could supply this Artifact.")
}

func decodeDigest(value string) ([32]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return [32]byte{}, errors.New("digest is invalid")
	}
	var result [32]byte
	copy(result[:], decoded)
	return result, nil
}

func (r *Runtime) hostedSessionForRemote(remoteID string) (remoteState, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, value := range r.vaults {
		for _, remote := range value.Remotes {
			if remote.RemoteID == remoteID {
				return remote, nil
			}
		}
	}
	return remoteState{}, fmt.Errorf("remote %s not found", remoteID)
}
