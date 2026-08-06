package vault

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	awsmcrypto "github.com/mashuproject/awsm_bak/apps/runtime-go/internal/crypto"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

func TestHostedReplicaHTTPClientUsesStrictProtocolAndOpaqueItems(t *testing.T) {
	var stored []byte
	locator := [32]byte{2}
	var storedItemID [32]byte
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Awsm-Protocol-Version", "1")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/sessions":
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"account":    map[string]any{"username": "alice", "inactive_deletion_at": "2026-08-07T00:00:00.000Z"},
				"session_id": "00000000-0000-4000-8000-000000000001", "access_token": "access", "access_expires_at": "2026-08-07T00:00:00.000Z",
				"refresh_token": "refresh", "refresh_expires_at": "2026-08-08T00:00:00.000Z",
			})
		case request.Method == http.MethodPost && request.URL.Path == "/api/replicas":
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(map[string]any{"replica_handle": "00000000-0000-4000-8000-000000000002", "locator_salt": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "capabilities": []string{"awsm.replica.inventory.read", "awsm.replica.item.read", "awsm.replica.item.write"}, "quota_bytes": nil, "stored_bytes": 0})
		case request.Method == http.MethodPut && strings.Contains(request.URL.Path, "/api/replicas/00000000-0000-4000-8000-000000000002/items/"):
			encodedID := strings.TrimPrefix(request.URL.Path, "/api/replicas/00000000-0000-4000-8000-000000000002/items/")
			decodedID, decodeErr := base64.RawURLEncoding.DecodeString(encodedID)
			if decodeErr != nil || len(decodedID) != 32 {
				t.Fatalf("request Storage Item ID: %v", decodeErr)
			}
			copy(storedItemID[:], decodedID)
			var err error
			stored, err = io.ReadAll(request.Body)
			if err != nil {
				t.Fatal(err)
			}
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(map[string]any{"storage_item_id": base64.RawURLEncoding.EncodeToString(storedItemID[:]), "byte_length": len(stored), "admission": "stored", "hint_cursor": 1})
		case request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/api/replicas/00000000-0000-4000-8000-000000000002/items/"):
			writer.Header().Set("Content-Type", "application/octet-stream")
			writer.Header().Set("Content-Length", stringLength(stored))
			_, _ = writer.Write(stored)
		default:
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(writer).Encode(map[string]any{"outcome": "item_not_found", "retryable": false, "request_id": "00000000-0000-4000-8000-000000000003", "retry_after_seconds": nil})
		}
	}))
	defer server.Close()
	client := server.Client()
	client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // test-only fixture
	session, err := signInHostedReplica(context.Background(), server.URL, "alice", "password", client)
	if err != nil || session.AccessToken != "access" {
		t.Fatalf("sign in = %#v, %v", session, err)
	}
	endpoint := server.URL
	host, err := newHostedReplicaHTTP(endpoint, session.AccessToken, client)
	if err != nil {
		t.Fatal(err)
	}
	replica, err := host.createReplica(context.Background())
	if err != nil || replica.ReplicaHandle == "" {
		t.Fatalf("create replica = %#v, %v", replica, err)
	}
	key := make([]byte, 32)
	key[0] = 4
	epochID, err := awsmcrypto.KeyEpochID([32]byte{3}, key)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := awsmcrypto.SealCompactItem(awsmcrypto.CompactItemInput{VaultID: [32]byte{3}, KeyEpochID: epochID, KeyEpochKey: key, PayloadType: 1, PayloadBytes: []byte("payload")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := host.admitCompact(context.Background(), replica.ReplicaHandle, locator, encoded); err != nil {
		t.Fatalf("admit compact: %v", err)
	}
	item, err := host.item(context.Background(), replica.ReplicaHandle, storedItemID, int64(len(encoded)))
	if err != nil || string(item) != string(encoded) {
		t.Fatalf("read compact = %d bytes, %v", len(item), err)
	}
}

func stringLength(value []byte) string {
	return strconv.Itoa(len(value))
}

// newHostedRuntimeFixture supplies the minimum real Host surface required by
// CreateHostedReplica. It intentionally uses a TLS test server so the runtime
// exercises the same HTTPS-only endpoint validation as a deployed Host.
func newHostedRuntimeFixture(t *testing.T) (string, *http.Client) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Awsm-Protocol-Version", "1")
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/api/sessions"):
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"account":    map[string]any{"username": "alice", "inactive_deletion_at": "2026-08-07T00:00:00.000Z"},
				"session_id": "00000000-0000-4000-8000-000000000011", "access_token": "access", "access_expires_at": "2026-08-07T00:00:00.000Z",
				"refresh_token": "refresh", "refresh_expires_at": "2026-08-08T00:00:00.000Z",
			})
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/api/replicas"):
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"replica_handle": "00000000-0000-4000-8000-000000000012",
				"locator_salt":   base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
				"capabilities":   []string{"awsm.replica.inventory.read", "awsm.replica.item.read", "awsm.replica.item.write"},
				"quota_bytes":    nil,
				"stored_bytes":   0,
			})
		default:
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(writer).Encode(map[string]any{"outcome": "not_found", "retryable": false})
		}
	}))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // test-only fixture
	return server.URL + "/aws", client
}

type hostedSyncFixture struct {
	Endpoint string
	Client   *http.Client
	Handle   string
	Salt     [32]byte
	Items    map[[32]byte]hostedSyncFixtureItem
}

type hostedSyncFixtureItem struct {
	Bytes   []byte
	Locator [32]byte
}

func newHostedSyncFixture(t *testing.T) *hostedSyncFixture {
	t.Helper()
	fixture := &hostedSyncFixture{
		Handle: "00000000-0000-4000-8000-000000000022",
		Items:  make(map[[32]byte]hostedSyncFixtureItem),
	}
	fixture.Salt[0] = 9
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Awsm-Protocol-Version", "1")
		switch {
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/api/sessions"):
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{
				"account":    map[string]any{"username": "alice", "inactive_deletion_at": "2026-08-07T00:00:00.000Z"},
				"session_id": "00000000-0000-4000-8000-000000000021", "access_token": "access", "access_expires_at": "2026-08-07T00:00:00.000Z",
				"refresh_token": "refresh", "refresh_expires_at": "2026-08-08T00:00:00.000Z",
			})
		case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/api/replicas"):
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(fixture.summary())
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/api/replicas"):
			writer.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(writer).Encode(map[string]any{"replicas": []any{fixture.summary()}})
		case request.Method == http.MethodPut && strings.Contains(request.URL.Path, "/items/"):
			encodedID := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
			decodedID, decodeErr := base64.RawURLEncoding.DecodeString(encodedID)
			if decodeErr != nil || len(decodedID) != 32 {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			var itemID [32]byte
			copy(itemID[:], decodedID)
			body, readErr := io.ReadAll(request.Body)
			if readErr != nil {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			_, exists := fixture.Items[itemID]
			locatorBytes, locatorErr := base64.RawURLEncoding.DecodeString(request.Header.Get("Awsm-Opaque-Locator"))
			if locatorErr != nil || len(locatorBytes) != 32 {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			var locator [32]byte
			copy(locator[:], locatorBytes)
			fixture.Items[itemID] = hostedSyncFixtureItem{Bytes: append([]byte(nil), body...), Locator: locator}
			writer.Header().Set("Content-Type", "application/json")
			if exists {
				_ = json.NewEncoder(writer).Encode(map[string]any{"storage_item_id": encodedID, "byte_length": len(body), "admission": "already_present", "hint_cursor": 1})
			} else {
				writer.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(writer).Encode(map[string]any{"storage_item_id": encodedID, "byte_length": len(body), "admission": "stored", "hint_cursor": 1})
			}
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/inventory"):
			fixture.writeInventory(writer, request)
		case request.Method == http.MethodGet && strings.Contains(request.URL.Path, "/items/"):
			encodedID := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
			decodedID, decodeErr := base64.RawURLEncoding.DecodeString(encodedID)
			if decodeErr != nil || len(decodedID) != 32 {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			var itemID [32]byte
			copy(itemID[:], decodedID)
			item, ok := fixture.Items[itemID]
			if !ok {
				writer.Header().Set("Content-Type", "application/json")
				writer.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(writer).Encode(map[string]any{"outcome": "item_not_found", "retryable": false})
				return
			}
			writer.Header().Set("Content-Type", "application/octet-stream")
			writer.Header().Set("Content-Length", strconv.Itoa(len(item.Bytes)))
			_, _ = writer.Write(item.Bytes)
		default:
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(writer).Encode(map[string]any{"outcome": "not_found", "retryable": false})
		}
	}))
	t.Cleanup(server.Close)
	fixture.Endpoint = server.URL + "/aws"
	fixture.Client = server.Client()
	fixture.Client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // test-only fixture
	return fixture
}

func (fixture *hostedSyncFixture) summary() map[string]any {
	return map[string]any{
		"replica_handle": fixture.Handle,
		"locator_salt":   base64.RawURLEncoding.EncodeToString(fixture.Salt[:]),
		"capabilities":   []string{"awsm.replica.inventory.read", "awsm.replica.item.read", "awsm.replica.item.write"},
		"quota_bytes":    nil,
		"stored_bytes":   len(fixture.Items),
	}
}

func (fixture *hostedSyncFixture) writeInventory(writer http.ResponseWriter, request *http.Request) {
	ids := make([][32]byte, 0, len(fixture.Items))
	for id := range fixture.Items {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(left, right int) bool { return strings.Compare(string(ids[left][:]), string(ids[right][:])) < 0 })
	start := 0
	if position := request.URL.Query().Get("position"); position != "" {
		decoded, err := base64.RawURLEncoding.DecodeString(position)
		if err != nil || len(decoded) != 32 {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		for index, id := range ids {
			if string(id[:]) == string(decoded) {
				start = index + 1
				break
			}
		}
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	if limit < 1 {
		limit = 100
	}
	end := start + limit
	if end > len(ids) {
		end = len(ids)
	}
	items := make([]map[string]any, 0, end-start)
	for _, id := range ids[start:end] {
		item := fixture.Items[id]
		envelope, err := storage.DecodeOpaqueEnvelope(item.Bytes)
		if err != nil {
			continue
		}
		storageClass := "compact"
		if envelope.StorageClass == storage.StreamableStorageClass {
			storageClass = "streamable"
		}
		items = append(items, map[string]any{
			"storage_item_id":   base64.RawURLEncoding.EncodeToString(id[:]),
			"storage_class":     storageClass,
			"byte_length":       len(item.Bytes),
			"ciphertext_digest": base64.RawURLEncoding.EncodeToString(envelope.CiphertextDigest[:]),
			"locator":           base64.RawURLEncoding.EncodeToString(item.Locator[:]),
		})
	}
	var next any
	if end < len(ids) && end > start {
		next = base64.RawURLEncoding.EncodeToString(ids[end-1][:])
	}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(map[string]any{"snapshot_cursor": 1, "next_position": next, "items": items})
}

func (fixture *hostedSyncFixture) addItem(t *testing.T, locator [32]byte, encoded []byte) [32]byte {
	t.Helper()
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil {
		t.Fatalf("decode fixture item: %v", err)
	}
	fixture.Items[envelope.StorageItemID] = hostedSyncFixtureItem{Bytes: append([]byte(nil), encoded...), Locator: locator}
	return envelope.StorageItemID
}
