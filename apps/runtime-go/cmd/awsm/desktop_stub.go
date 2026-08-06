//go:build !desktop

package main

import (
	"errors"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

func defaultMode() string {
	return "serve"
}

func runDesktop(_ *application.Application) error {
	return errors.New("desktop mode requires a build with -tags desktop")
}
