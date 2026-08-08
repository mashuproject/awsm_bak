//go:build !e2e

package main

import (
	"context"
	"errors"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/application"
)

func seedCollection(_ *application.Application, _ context.Context, _ string) (string, error) {
	return "", errors.New("seed collection requires the e2e build tag")
}
