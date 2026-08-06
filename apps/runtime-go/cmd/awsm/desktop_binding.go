package main

import (
	"context"
	"encoding/json"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

// desktopBinding is the narrow Wails bridge. It exposes only management
// metadata and actions; bearer tokens never cross into the desktop UI.
type desktopBinding struct {
	app *application.Application
}

func (b *desktopBinding) PendingPairings() any {
	return b.app.PendingPairings()
}

func (b *desktopBinding) ApprovePairing(pairingID string) error {
	return b.app.ApprovePairing(pairingID)
}

func (b *desktopBinding) RevokeGrant(grantID string) error {
	return b.app.RevokeGrant(grantID)
}

func (b *desktopBinding) ListGrants() any {
	return b.app.GrantSummaries()
}

func (b *desktopBinding) RuntimeAddress() string {
	return b.app.Address()
}

func (b *desktopBinding) RuntimeVersion() string {
	return appVersion
}

// VaultCommand is the Wails presentation adapter for the same tagged command
// contract exposed by the authenticated loopback API. It does not expose
// storage or private key material to JavaScript.
func (b *desktopBinding) VaultCommand(request map[string]any) (any, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	return b.app.VaultRuntime().Handle(context.Background(), raw)
}

func (b *desktopBinding) PendingTransfers() any {
	return b.app.PendingTransfers()
}

func (b *desktopBinding) AcceptTransfer(transferID string) error {
	return b.app.AcceptTransfer(transferID)
}

func (b *desktopBinding) RejectTransfer(transferID string) error {
	return b.app.RejectTransfer(transferID)
}
