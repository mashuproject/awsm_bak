//go:build desktop

package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"syscall"
	"time"

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
	shutdownSignals := make(chan os.Signal, 1)
	signal.Notify(shutdownSignals, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(shutdownSignals)
	go func() {
		<-shutdownSignals
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = app.Shutdown(ctx)
	}()

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
