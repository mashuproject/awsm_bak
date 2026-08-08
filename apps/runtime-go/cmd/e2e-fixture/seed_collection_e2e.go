//go:build e2e

package main

import (
	"context"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

func seedCollection(app *application.Application, ctx context.Context, vaultID string) (string, error) {
	return app.VaultRuntime().SeedCollectionForE2E(ctx, vaultID)
}
