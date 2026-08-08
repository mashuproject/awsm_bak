//go:build desktop

package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed frontend/dist/*
var frontend embed.FS

func defaultMode() string {
	return "desktop"
}

func runDesktop(app *application.Application) error {
	assets, err := fs.Sub(frontend, "frontend/dist")
	if err != nil {
		return fmt.Errorf("prepare desktop assets: %w", err)
	}
	const runtimeInvalidationEvent = "awsm.runtime.invalidated"
	if err := wails.Run(&options.App{
		Title:            "AWSM",
		Width:            1100,
		Height:           760,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 16, G: 20, B: 24, A: 1},
		Bind:             []interface{}{&desktopBinding{app: app}},
		OnStartup: func(ctx context.Context) {
			app.VaultRuntime().SetNotifier(func() {
				wailsruntime.EventsEmit(ctx, runtimeInvalidationEvent)
			})
		},
		OnShutdown: func(ctx context.Context) {
			app.VaultRuntime().SetNotifier(nil)
			_ = app.Shutdown(ctx)
		},
	}); err != nil {
		return fmt.Errorf("run Wails desktop: %w", err)
	}
	return nil
}
