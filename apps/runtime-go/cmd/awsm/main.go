package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

var appVersion = "dev"

func main() {
	mode := flag.String("mode", defaultMode(), "launch mode: serve or desktop")
	dataDir := flag.String("data-dir", "", "PocketBase data directory")
	listenAddress := flag.String("listen", application.DefaultListenAddress, "HTTP listen address")
	readyFile := flag.String("ready-file", "", "write the bound address to this file after startup")
	flag.Parse()
	if *mode == "desktop" && *listenAddress != application.DefaultListenAddress {
		fatal(fmt.Errorf("desktop mode requires the default loopback Runtime address"))
	}

	if *dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			fatal(err)
		}
		*dataDir = filepath.Join(base, "awsm", "runtime")
	}

	app, err := application.New(application.Config{
		DataDir:       *dataDir,
		ListenAddress: *listenAddress,
		ReadyFile:     *readyFile,
	})
	if err != nil {
		fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
	}()

	if err := app.Start(); err != nil {
		fatal(err)
	}

	switch *mode {
	case "serve":
		waitForSignal(app)
	case "desktop":
		if err := runDesktop(app); err != nil {
			fatal(err)
		}
	default:
		fatal(fmt.Errorf("unsupported mode %q", *mode))
	}
}

func waitForSignal(app *application.Application) {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
