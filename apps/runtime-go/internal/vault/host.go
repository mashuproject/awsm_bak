package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

const hostedProtocolVersion = "1"

type hostedSession struct {
	Username         string
	SessionID        string
	AccessToken      string
	AccessExpiresAt  int64
	RefreshToken     string
	RefreshExpiresAt int64
}

type hostedReplicaSummary struct {
	ReplicaHandle string
	LocatorSalt   [32]byte
	Capabilities  []string
	QuotaBytes    *int64
	StoredBytes   int64
}

type hostedInventoryItem struct {
	StorageItemID [32]byte
	StorageClass  uint64
	ByteLength    int64
	CipherDigest  [32]byte
	Locator       [32]byte
}

type hostedInventoryPage struct {
	SnapshotCursor int64
	NextPosition   *[32]byte
	Items          []hostedInventoryItem
}

type hostedAdmission struct {
	StorageItemID [32]byte
	ByteLength    int64
	Admission     string
	HintCursor    int64
}

type hostedHTTPError struct {
	Outcome          string
	Retryable        bool
	RetryAfterSecond *int64
	Status           int
}

func (e *hostedHTTPError) Error() string {
	return fmt.Sprintf("Hosted Replica request failed: %s", e.Outcome)
}

func signInHostedReplica(ctx context.Context, endpoint, username, password string, client *http.Client) (hostedSession, error) {
	if username == "" || password == "" {
		return hostedSession{}, errors.New("Hosted Replica credentials are required")
	}
	requestURL, err := hostedURL(endpoint, "api/sessions")
	if err != nil {
		return hostedSession{}, err
	}
	body, err := json.Marshal(map[string]string{"username": username, "password": password})
	if err != nil {
		return hostedSession{}, err
	}
	request, err := newHostedRequest(ctx, http.MethodPost, requestURL, nil, bytes.NewReader(body))
	if err != nil {
		return hostedSession{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := hostedClient(client).Do(request)
	if err != nil {
		return hostedSession{}, fmt.Errorf("Hosted Replica sign-in transport: %w", err)
	}
	defer response.Body.Close()
	if !responseHasProtocol(response) {
		return hostedSession{}, errors.New("Hosted Replica sign-in protocol version is invalid")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return hostedSession{}, decodeHostedHTTPError(response)
	}
	var payload struct {
		Account struct {
			Username           string `json:"username"`
			InactiveDeletionAt string `json:"inactive_deletion_at"`
		} `json:"account"`
		SessionID        string `json:"session_id"`
		AccessToken      string `json:"access_token"`
		AccessExpiresAt  string `json:"access_expires_at"`
		RefreshToken     string `json:"refresh_token"`
		RefreshExpiresAt string `json:"refresh_expires_at"`
	}
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return hostedSession{}, err
	}
	if payload.Account.Username != username || payload.SessionID == "" || payload.AccessToken == "" || payload.RefreshToken == "" {
		return hostedSession{}, errors.New("Hosted Replica sign-in response is invalid")
	}
	accessExpiresAt, err := hostedTimestamp(payload.AccessExpiresAt)
	if err != nil {
		return hostedSession{}, err
	}
	refreshExpiresAt, err := hostedTimestamp(payload.RefreshExpiresAt)
	if err != nil {
		return hostedSession{}, err
	}
	if _, err := hostedTimestamp(payload.Account.InactiveDeletionAt); err != nil {
		return hostedSession{}, err
	}
	return hostedSession{Username: payload.Account.Username, SessionID: payload.SessionID, AccessToken: payload.AccessToken, AccessExpiresAt: accessExpiresAt, RefreshToken: payload.RefreshToken, RefreshExpiresAt: refreshExpiresAt}, nil
}

func refreshHostedReplica(ctx context.Context, endpoint string, refreshToken string, client *http.Client) (hostedSession, error) {
	requestURL, err := hostedURL(endpoint, "api/session/refresh")
	if err != nil {
		return hostedSession{}, err
	}
	body, err := json.Marshal(map[string]string{"refresh_token": refreshToken})
	if err != nil {
		return hostedSession{}, err
	}
	request, err := newHostedRequest(ctx, http.MethodPost, requestURL, nil, bytes.NewReader(body))
	if err != nil {
		return hostedSession{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := hostedClient(client).Do(request)
	if err != nil {
		return hostedSession{}, fmt.Errorf("Hosted Replica session refresh transport: %w", err)
	}
	defer response.Body.Close()
	if !responseHasProtocol(response) {
		return hostedSession{}, errors.New("Hosted Replica session refresh protocol version is invalid")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return hostedSession{}, decodeHostedHTTPError(response)
	}
	var payload struct {
		Account struct {
			Username           string `json:"username"`
			InactiveDeletionAt string `json:"inactive_deletion_at"`
		} `json:"account"`
		SessionID        string `json:"session_id"`
		AccessToken      string `json:"access_token"`
		AccessExpiresAt  string `json:"access_expires_at"`
		RefreshToken     string `json:"refresh_token"`
		RefreshExpiresAt string `json:"refresh_expires_at"`
	}
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return hostedSession{}, err
	}
	accessExpiresAt, err := hostedTimestamp(payload.AccessExpiresAt)
	if err != nil {
		return hostedSession{}, err
	}
	refreshExpiresAt, err := hostedTimestamp(payload.RefreshExpiresAt)
	if err != nil {
		return hostedSession{}, err
	}
	if payload.Account.Username == "" || payload.SessionID == "" || payload.AccessToken == "" || payload.RefreshToken == "" {
		return hostedSession{}, errors.New("Hosted Replica session refresh response is invalid")
	}
	return hostedSession{Username: payload.Account.Username, SessionID: payload.SessionID, AccessToken: payload.AccessToken, AccessExpiresAt: accessExpiresAt, RefreshToken: payload.RefreshToken, RefreshExpiresAt: refreshExpiresAt}, nil
}

type hostedReplicaHTTP struct {
	Endpoint   string
	Bearer     string
	HTTPClient *http.Client
}

func newHostedReplicaHTTP(endpoint, bearer string, client *http.Client) (*hostedReplicaHTTP, error) {
	if _, err := hostedURL(endpoint, "api/replicas"); err != nil {
		return nil, err
	}
	if bearer == "" {
		return nil, errors.New("Hosted Replica bearer credential is required")
	}
	return &hostedReplicaHTTP{Endpoint: endpoint, Bearer: bearer, HTTPClient: client}, nil
}

func (h *hostedReplicaHTTP) createReplica(ctx context.Context) (hostedReplicaSummary, error) {
	response, err := h.request(ctx, http.MethodPost, "api/replicas", nil, bytes.NewReader([]byte("{}")), "application/json")
	if err != nil {
		return hostedReplicaSummary{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return hostedReplicaSummary{}, decodeHostedHTTPError(response)
	}
	var payload map[string]any
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return hostedReplicaSummary{}, err
	}
	return decodeHostedReplicaSummary(payload)
}

func (h *hostedReplicaHTTP) listReplicas(ctx context.Context) ([]hostedReplicaSummary, error) {
	response, err := h.request(ctx, http.MethodGet, "api/replicas", nil, nil, "application/json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, decodeHostedHTTPError(response)
	}
	var payload struct {
		Replicas []map[string]any `json:"replicas"`
	}
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return nil, err
	}
	result := make([]hostedReplicaSummary, 0, len(payload.Replicas))
	for _, value := range payload.Replicas {
		replica, err := decodeHostedReplicaSummary(value)
		if err != nil {
			return nil, err
		}
		result = append(result, replica)
	}
	return result, nil
}

func (h *hostedReplicaHTTP) admitCompact(ctx context.Context, replicaHandle string, locator [32]byte, encoded []byte) (hostedAdmission, error) {
	envelope, err := storage.DecodeOpaqueEnvelope(encoded)
	if err != nil || envelope.StorageClass != storage.CompactStorageClass {
		return hostedAdmission{}, errors.New("Hosted Replica admission requires a Compact opaque envelope")
	}
	path := "api/replicas/" + url.PathEscape(replicaHandle) + "/items/" + base64.RawURLEncoding.EncodeToString(envelope.StorageItemID[:])
	response, err := h.request(ctx, http.MethodPut, path, map[string]string{"Awsm-Opaque-Locator": base64.RawURLEncoding.EncodeToString(locator[:])}, bytes.NewReader(encoded), "application/octet-stream")
	if err != nil {
		return hostedAdmission{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return hostedAdmission{}, decodeHostedHTTPError(response)
	}
	var payload struct {
		StorageItemID string `json:"storage_item_id"`
		ByteLength    int64  `json:"byte_length"`
		Admission     string `json:"admission"`
		HintCursor    int64  `json:"hint_cursor"`
	}
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return hostedAdmission{}, err
	}
	storageItemID, err := decodeHostedDigest(payload.StorageItemID)
	if err != nil || storageItemID != envelope.StorageItemID || payload.ByteLength != int64(len(encoded)) || (payload.Admission != "stored" && payload.Admission != "already_present") {
		return hostedAdmission{}, errors.New("Hosted Replica admission response does not match the submitted item")
	}
	return hostedAdmission{StorageItemID: storageItemID, ByteLength: payload.ByteLength, Admission: payload.Admission, HintCursor: payload.HintCursor}, nil
}

func (h *hostedReplicaHTTP) inventory(ctx context.Context, replicaHandle string, snapshotCursor *int64, position *[32]byte, limit int) (hostedInventoryPage, error) {
	values := url.Values{"limit": {strconv.Itoa(limit)}}
	if snapshotCursor != nil {
		values.Set("snapshot_cursor", strconv.FormatInt(*snapshotCursor, 10))
	}
	if position != nil {
		values.Set("position", base64.RawURLEncoding.EncodeToString(position[:]))
	}
	path := "api/replicas/" + url.PathEscape(replicaHandle) + "/inventory?" + values.Encode()
	response, err := h.request(ctx, http.MethodGet, path, nil, nil, "application/json")
	if err != nil {
		return hostedInventoryPage{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return hostedInventoryPage{}, decodeHostedHTTPError(response)
	}
	var payload struct {
		SnapshotCursor int64            `json:"snapshot_cursor"`
		NextPosition   *string          `json:"next_position"`
		Items          []map[string]any `json:"items"`
	}
	if err := decodeHostedJSON(response.Body, &payload); err != nil {
		return hostedInventoryPage{}, err
	}
	var next *[32]byte
	if payload.NextPosition != nil {
		value, err := decodeHostedDigest(*payload.NextPosition)
		if err != nil {
			return hostedInventoryPage{}, err
		}
		next = &value
	}
	items := make([]hostedInventoryItem, 0, len(payload.Items))
	for _, item := range payload.Items {
		storageItemID, err := decodeHostedDigest(stringValue(item, "storage_item_id"))
		if err != nil {
			return hostedInventoryPage{}, err
		}
		locator, err := decodeHostedDigest(stringValue(item, "locator"))
		if err != nil {
			return hostedInventoryPage{}, err
		}
		digest, err := decodeHostedDigest(stringValue(item, "ciphertext_digest"))
		if err != nil {
			return hostedInventoryPage{}, err
		}
		storageClassText := stringValue(item, "storage_class")
		storageClass := uint64(0)
		if storageClassText == "compact" {
			storageClass = 1
		} else if storageClassText == "streamable" {
			storageClass = 2
		} else {
			return hostedInventoryPage{}, errors.New("Hosted Replica inventory storage class is invalid")
		}
		byteLength, err := integerValue(item, "byte_length")
		if err != nil || byteLength < 1 {
			return hostedInventoryPage{}, errors.New("Hosted Replica inventory byte length is invalid")
		}
		items = append(items, hostedInventoryItem{StorageItemID: storageItemID, StorageClass: storageClass, ByteLength: byteLength, CipherDigest: digest, Locator: locator})
	}
	return hostedInventoryPage{SnapshotCursor: payload.SnapshotCursor, NextPosition: next, Items: items}, nil
}

func (h *hostedReplicaHTTP) item(ctx context.Context, replicaHandle string, storageItemID [32]byte, byteLength int64) ([]byte, error) {
	path := "api/replicas/" + url.PathEscape(replicaHandle) + "/items/" + base64.RawURLEncoding.EncodeToString(storageItemID[:])
	response, err := h.request(ctx, http.MethodGet, path, nil, nil, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, decodeHostedHTTPError(response)
	}
	if response.Header.Get("Content-Type") != "application/octet-stream" || response.Header.Get("Content-Length") != strconv.FormatInt(byteLength, 10) {
		return nil, errors.New("Hosted Replica item response does not match its inventory")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, byteLength+1))
	if err != nil || int64(len(data)) != byteLength {
		return nil, errors.New("Hosted Replica item byte length is invalid")
	}
	return data, nil
}

func (h *hostedReplicaHTTP) request(ctx context.Context, method, path string, extraHeaders map[string]string, body io.Reader, contentType string) (*http.Response, error) {
	requestURL, err := hostedURL(h.Endpoint, path)
	if err != nil {
		return nil, err
	}
	request, err := newHostedRequest(ctx, method, requestURL, extraHeaders, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+h.Bearer)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := hostedClient(h.HTTPClient).Do(request)
	if err != nil {
		return nil, fmt.Errorf("Hosted Replica transport: %w", err)
	}
	if !responseHasProtocol(response) {
		response.Body.Close()
		return nil, errors.New("Hosted Replica response protocol version is invalid")
	}
	return response, nil
}

func hostedURL(endpoint, path string) (*url.URL, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Opaque != "" {
		return nil, errors.New("Hosted Replica endpoint must be a canonical HTTPS URL")
	}
	relative, err := url.Parse(path)
	if err != nil || relative.IsAbs() {
		return nil, errors.New("Hosted Replica request path is invalid")
	}
	path = strings.TrimPrefix(relative.Path, "/")
	basePath := strings.TrimRight(parsed.Path, "/")
	parsed.Path = basePath + "/" + path
	parsed.RawQuery = relative.RawQuery
	return parsed, nil
}

func newHostedRequest(ctx context.Context, method string, requestURL *url.URL, extraHeaders map[string]string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, requestURL.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Awsm-Protocol-Version", hostedProtocolVersion)
	request.Header.Set("Awsm-Request-ID", uuid.NewString())
	for key, value := range extraHeaders {
		request.Header.Set(key, value)
	}
	return request, nil
}

func hostedClient(client *http.Client) *http.Client {
	if client == nil {
		client = http.DefaultClient
	}
	copyValue := *client
	copyValue.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return &copyValue
}

func responseHasProtocol(response *http.Response) bool {
	return response != nil && response.Header.Get("Awsm-Protocol-Version") == hostedProtocolVersion
}

func decodeHostedHTTPError(response *http.Response) error {
	var payload struct {
		Outcome          string `json:"outcome"`
		Retryable        bool   `json:"retryable"`
		RetryAfterSecond *int64 `json:"retry_after_seconds"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil || payload.Outcome == "" {
		return &hostedHTTPError{Outcome: "protocol_invalid", Status: response.StatusCode}
	}
	return &hostedHTTPError{Outcome: payload.Outcome, Retryable: payload.Retryable, RetryAfterSecond: payload.RetryAfterSecond, Status: response.StatusCode}
}

func decodeHostedJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("Hosted Replica JSON response contains trailing data")
	}
	return nil
}

func hostedTimestamp(value string) (int64, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.UTC().Format("2006-01-02T15:04:05.000Z") != value {
		return 0, errors.New("Hosted Replica timestamp is not canonical")
	}
	return parsed.UnixMilli(), nil
}

func decodeHostedDigest(value string) ([32]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return [32]byte{}, errors.New("Hosted Replica digest is invalid")
	}
	var result [32]byte
	copy(result[:], decoded)
	return result, nil
}

func decodeHostedReplicaSummary(value map[string]any) (hostedReplicaSummary, error) {
	handle, ok := value["replica_handle"].(string)
	if !ok || uuid.Validate(handle) != nil {
		return hostedReplicaSummary{}, errors.New("Hosted Replica handle is invalid")
	}
	locatorSalt, err := decodeHostedDigest(stringValue(value, "locator_salt"))
	if err != nil {
		return hostedReplicaSummary{}, err
	}
	capabilitiesValue, ok := value["capabilities"].([]any)
	if !ok || len(capabilitiesValue) == 0 {
		return hostedReplicaSummary{}, errors.New("Hosted Replica capabilities are invalid")
	}
	capabilities := make([]string, len(capabilitiesValue))
	for index, capability := range capabilitiesValue {
		text, ok := capability.(string)
		if !ok || text == "" {
			return hostedReplicaSummary{}, errors.New("Hosted Replica capability is invalid")
		}
		capabilities[index] = text
	}
	storedBytes, err := integerValue(value, "stored_bytes")
	if err != nil || storedBytes < 0 {
		return hostedReplicaSummary{}, errors.New("Hosted Replica stored bytes are invalid")
	}
	var quota *int64
	if raw, ok := value["quota_bytes"]; ok && raw != nil {
		parsed, ok := raw.(float64)
		if !ok || parsed < 1 || parsed != float64(int64(parsed)) {
			return hostedReplicaSummary{}, errors.New("Hosted Replica quota is invalid")
		}
		quotaValue := int64(parsed)
		quota = &quotaValue
		if storedBytes > quotaValue {
			return hostedReplicaSummary{}, errors.New("Hosted Replica stored bytes exceed quota")
		}
	}
	return hostedReplicaSummary{ReplicaHandle: handle, LocatorSalt: locatorSalt, Capabilities: capabilities, QuotaBytes: quota, StoredBytes: storedBytes}, nil
}

func stringValue(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}

func integerValue(value map[string]any, key string) (int64, error) {
	number, ok := value[key].(float64)
	if !ok || number != float64(int64(number)) {
		return 0, errors.New("value is not an integer")
	}
	return int64(number), nil
}
