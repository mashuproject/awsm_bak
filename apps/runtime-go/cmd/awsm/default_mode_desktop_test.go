//go:build desktop

package main

import "testing"

func TestDefaultModeForDesktopBuild(t *testing.T) {
	if got := defaultMode(); got != "desktop" {
		t.Fatalf("default mode = %q, want desktop", got)
	}
}
