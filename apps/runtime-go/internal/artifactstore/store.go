// Package artifactstore stores already-encrypted Artifact wrappers without
// interpreting their contents. Encryption and authenticated object identity
// remain Runtime responsibilities.
package artifactstore

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var ErrInvalidArtifactID = errors.New("invalid artifact id")

type Store struct {
	root string
}

func New(root string) (*Store, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("artifact root is required")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create artifact root: %w", err)
	}
	return &Store{root: root}, nil
}

// Put atomically replaces one opaque wrapper. The source is streamed to a
// private temporary file before promotion, so an interrupted write cannot
// expose a partial wrapper under the stable artifact ID.
func (s *Store) Put(id string, source io.Reader) error {
	path, err := s.path(id)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(s.root, ".awsm-artifact-*")
	if err != nil {
		return fmt.Errorf("create artifact staging file: %w", err)
	}
	temporaryName := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}
	defer cleanup()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("protect artifact staging file: %w", err)
	}
	if _, err := io.Copy(temporary, source); err != nil {
		return fmt.Errorf("write artifact staging file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync artifact staging file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close artifact staging file: %w", err)
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return fmt.Errorf("promote artifact: %w", err)
	}
	return nil
}

func (s *Store) Open(id string) (io.ReadCloser, error) {
	path, err := s.path(id)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func (s *Store) Delete(id string) error {
	path, err := s.path(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	return nil
}

// ListIDs returns the opaque Storage Item IDs currently materialized in this
// store. It exposes filenames only; callers still authenticate each retained
// mapping before deciding what may be collected.
func (s *Store) ListIDs() ([]string, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".bin") || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".bin")
		if _, err := s.path(id); err != nil {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func (s *Store) path(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, `/\\`) || id == "." || id == ".." || filepath.Base(id) != id {
		return "", ErrInvalidArtifactID
	}
	return filepath.Join(s.root, id+".bin"), nil
}
