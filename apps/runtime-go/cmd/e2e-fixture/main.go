// Command e2e-fixture starts a real Runtime listener with a trusted,
// line-oriented control channel for browser end-to-end tests. It is not a
// product API and is never built into the desktop binary.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

type command struct {
	Name      string `json:"command"`
	GrantID   string `json:"grantId,omitempty"`
	PairingID string `json:"pairingId,omitempty"`
	VaultID   string `json:"vaultId,omitempty"`
}

func main() {
	dataDir := flag.String("data-dir", "", "Runtime data directory")
	listenAddress := flag.String("listen", application.DefaultListenAddress, "Runtime listen address")
	flag.Parse()
	if *dataDir == "" {
		fatal(fmt.Errorf("data directory is required"))
	}
	app, err := application.New(application.Config{DataDir: *dataDir, ListenAddress: *listenAddress})
	if err != nil {
		fatal(err)
	}
	if err := app.Start(); err != nil {
		fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = app.Shutdown(ctx)
	}()

	write(map[string]any{"event": "ready", "address": app.Address()})
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var input command
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			write(map[string]any{"ok": false, "error": "invalid command"})
			continue
		}
		switch input.Name {
		case "approve":
			write(map[string]any{"ok": app.ApprovePairing(input.PairingID) == nil})
		case "approve-next":
			write(approveNext(app))
		case "revoke-all":
			write(revokeAll(app))
		case "seed-collection":
			collectionID, err := seedCollection(app, context.Background(), input.VaultID)
			if err != nil {
				write(map[string]any{"ok": false, "error": "collection seed failed"})
			} else {
				write(map[string]any{"ok": true, "collectionId": collectionID})
			}
		case "shutdown":
			write(map[string]any{"ok": true})
			return
		default:
			write(map[string]any{"ok": false, "error": "unknown command"})
		}
	}
}

func approveNext(app *application.Application) map[string]any {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		pending := app.PendingPairings()
		if len(pending) > 0 {
			if err := app.ApprovePairing(pending[0].ID); err != nil {
				return map[string]any{"ok": false, "error": "approval failed"}
			}
			return map[string]any{"ok": true}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return map[string]any{"ok": false, "error": "no pending pairing"}
}

func revokeAll(app *application.Application) map[string]any {
	for _, grant := range app.GrantSummaries() {
		if !grant.Revoked {
			if err := app.RevokeGrant(grant.ID); err != nil {
				return map[string]any{"ok": false, "error": "revocation failed"}
			}
		}
	}
	return map[string]any{"ok": true}
}

func write(value map[string]any) {
	bytes, err := json.Marshal(value)
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(bytes))
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
