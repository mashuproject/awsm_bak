//go:build !desktop

package main

import "testing"

func TestDefaultModeForServerBuild(t *testing.T) {
	if got := defaultMode(); got != "serve" {
		t.Fatalf("default mode = %q, want serve", got)
	}
}
