package application

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestApplicationServesLoopbackRuntimeAPIAndShutsDown(t *testing.T) {
	app, err := New(Config{DataDir: t.TempDir(), ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("create application: %v", err)
	}
	if err := app.Start(); err != nil {
		t.Fatalf("start application: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown application: %v", err)
		}
	}()

	response, err := http.Get("http://" + app.Address() + "/api/awsm/runtime/health")
	if err != nil {
		t.Fatalf("request runtime health: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("runtime health status = %d, want %d", response.StatusCode, http.StatusOK)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read runtime health: %v", err)
	}
	if string(body) != "{\"status\":\"ok\"}\n" {
		t.Fatalf("runtime health body = %q", body)
	}
}

func TestApplicationWaitReportsUnexpectedServeFailure(t *testing.T) {
	app, err := New(Config{DataDir: t.TempDir(), ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("create application: %v", err)
	}
	if err := app.Start(); err != nil {
		t.Fatalf("start application: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = app.Shutdown(ctx)
	}()

	app.mu.Lock()
	listener := app.listener
	app.mu.Unlock()
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	waitResult := make(chan error, 1)
	go func() { waitResult <- app.Wait() }()
	select {
	case err := <-waitResult:
		if err == nil {
			t.Fatal("Wait returned nil after an unexpected serve failure")
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not return after an unexpected serve failure")
	}
}

func TestApplicationWritesAtomicReadyFileAfterBindingPort(t *testing.T) {
	dataDir := t.TempDir()
	readyFile := filepath.Join(t.TempDir(), "runtime-ready.json")
	app, err := New(Config{
		DataDir:       dataDir,
		ListenAddress: "127.0.0.1:0",
		ReadyFile:     readyFile,
	})
	if err != nil {
		t.Fatalf("create application: %v", err)
	}
	if err := app.Start(); err != nil {
		t.Fatalf("start application: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown application: %v", err)
		}
	}()

	deadline := time.Now().Add(time.Second)
	var content []byte
	for time.Now().Before(deadline) {
		content, err = os.ReadFile(readyFile)
		if err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err != nil {
		t.Fatalf("read ready file: %v", err)
	}
	var ready struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(content, &ready); err != nil {
		t.Fatalf("decode ready file: %v", err)
	}
	if ready.Address != app.Address() {
		t.Fatalf("ready address = %q, application address = %q", ready.Address, app.Address())
	}
	if bytes.Contains(content, []byte("token")) || bytes.Contains(content, []byte("secret")) {
		t.Fatal("ready file contains confidential fields")
	}
}

func TestApplicationDoesNotRemainRunningWhenReadyFileCannotBeWritten(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(parent, []byte("occupied"), 0o600); err != nil {
		t.Fatalf("create occupied ready parent: %v", err)
	}
	app, err := New(Config{
		DataDir:       t.TempDir(),
		ListenAddress: "127.0.0.1:0",
		ReadyFile:     filepath.Join(parent, "runtime-ready.json"),
	})
	if err != nil {
		t.Fatalf("create application: %v", err)
	}
	if err := app.Start(); err == nil {
		t.Fatal("start application unexpectedly succeeded")
	}
	if app.listener != nil {
		t.Fatal("application retained a listener after ready-file failure")
	}
}

func TestApplicationRunsRealTCPPairingPersistenceAndRevocationJourney(t *testing.T) {
	dataDir := t.TempDir()
	app, err := New(Config{DataDir: dataDir, ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("create application: %v", err)
	}
	if err := app.Start(); err != nil {
		t.Fatalf("start application: %v", err)
	}
	address := app.Address()
	client := &http.Client{Timeout: time.Second}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Fatalf("shutdown application: %v", err)
		}
	}()

	requestJSON := func(method, path string, body []byte, token string) (*http.Response, []byte) {
		t.Helper()
		request, err := http.NewRequest(method, "http://"+address+path, bytes.NewReader(body))
		if err != nil {
			t.Fatalf("create request: %v", err)
		}
		if len(body) > 0 {
			request.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("perform %s %s: %v", method, path, err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatalf("read %s %s response: %v", method, path, err)
		}
		return response, content
	}

	response, _ := requestJSON(http.MethodGet, "/api/awsm/runtime/health", nil, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d, want 200", response.StatusCode)
	}
	response, _ = requestJSON(http.MethodPost, "/api/awsm/runtime/pairings", []byte(`{"clientName":"extension","scopes":["runtime.vault"]}`), "")
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("begin pairing status = %d, want 201", response.StatusCode)
	}
	// The HTTP response is decoded below after the body has been read by the helper.
	response, pairingBody := requestJSON(http.MethodPost, "/api/awsm/runtime/pairings", []byte(`{"clientName":"extension-journey","scopes":["runtime.vault"]}`), "")
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("journey pairing status = %d, want 201", response.StatusCode)
	}
	var pairing struct {
		ID   string `json:"pairingId"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(pairingBody, &pairing); err != nil {
		t.Fatalf("decode pairing: %v", err)
	}
	response, _ = requestJSON(http.MethodPost, "/api/awsm/runtime/pairings/"+pairing.ID+"/redeem", []byte(`{"code":"`+pairing.Code+`"}`), "")
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("unapproved redemption status = %d, want 409", response.StatusCode)
	}
	if err := app.ApprovePairing(pairing.ID); err != nil {
		t.Fatalf("approve pairing: %v", err)
	}
	response, grantBody := requestJSON(http.MethodPost, "/api/awsm/runtime/pairings/"+pairing.ID+"/redeem", []byte(`{"code":"`+pairing.Code+`"}`), "")
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("approved redemption status = %d, want 201", response.StatusCode)
	}
	var grant struct {
		ID    string `json:"grantId"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(grantBody, &grant); err != nil {
		t.Fatalf("decode grant: %v", err)
	}
	if grant.ID == "" || grant.Token == "" {
		t.Fatal("redeemed grant must contain id and token")
	}
	response, _ = requestJSON(http.MethodGet, "/api/awsm/runtime/grants/me", nil, grant.Token)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("grant lookup status = %d, want 200", response.StatusCode)
	}
	response, _ = requestJSON(http.MethodGet, "/api/awsm/host/replicas", nil, grant.Token)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("host boundary status = %d, want 401", response.StatusCode)
	}

	if err := app.Shutdown(context.Background()); err != nil {
		t.Fatalf("restart shutdown: %v", err)
	}
	restarted, err := New(Config{DataDir: dataDir, ListenAddress: "127.0.0.1:0"})
	if err != nil {
		t.Fatalf("create restarted application: %v", err)
	}
	if err := restarted.Start(); err != nil {
		t.Fatalf("start restarted application: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = restarted.Shutdown(ctx)
	}()
	address = restarted.Address()
	response, _ = requestJSON(http.MethodGet, "/api/awsm/runtime/grants/me", nil, grant.Token)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("restarted grant lookup status = %d, want 200", response.StatusCode)
	}
	if err := restarted.RevokeGrant(grant.ID); err != nil {
		t.Fatalf("revoke grant: %v", err)
	}
	response, _ = requestJSON(http.MethodGet, "/api/awsm/runtime/grants/me", nil, grant.Token)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked grant lookup status = %d, want 401", response.StatusCode)
	}
}
