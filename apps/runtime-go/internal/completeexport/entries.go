package completeexport

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"

	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/canonical"
	"github.com/mashuproject/awsm_bak/apps/runtime-go/internal/storage"
)

const (
	ManifestEntryKind     uint64 = 1
	OpaqueEntryKind       uint64 = 2
	KeyInventoryEntryKind uint64 = 3
	MetadataLimit                = 16 * 1024 * 1024
)

type EntryHeader struct {
	Kind       uint64
	EntryID    [32]byte
	ByteLength uint64
	ByteDigest [32]byte
}

type Entry struct {
	Header EntryHeader
	Bytes  []byte
}

func PrepareEntry(kind uint64, body []byte) (Entry, error) {
	if kind < ManifestEntryKind || kind > KeyInventoryEntryKind {
		return Entry{}, errors.New("Complete Export entry kind is unsupported")
	}
	if kind != OpaqueEntryKind && len(body) > MetadataLimit {
		return Entry{}, errors.New("Complete Export metadata exceeds the portable bound")
	}
	exact := append([]byte(nil), body...)
	var entryID [32]byte
	if kind == OpaqueEntryKind {
		envelope, err := storage.DecodeOpaqueEnvelope(exact)
		if err != nil {
			return Entry{}, fmt.Errorf("decode Complete Export opaque entry: %w", err)
		}
		entryID = envelope.StorageItemID
	} else {
		entryID = EntryIdentity(kind, uint64(len(exact)), exact)
	}
	return Entry{Header: EntryHeader{Kind: kind, EntryID: entryID, ByteLength: uint64(len(exact)), ByteDigest: sha256.Sum256(exact)}, Bytes: exact}, nil
}

func EncodeEntryHeader(header EntryHeader) ([]byte, error) {
	if header.Kind < ManifestEntryKind || header.Kind > KeyInventoryEntryKind {
		return nil, errors.New("Complete Export entry kind is unsupported")
	}
	if header.Kind != OpaqueEntryKind && header.ByteLength > MetadataLimit {
		return nil, errors.New("Complete Export metadata exceeds the portable bound")
	}
	return canonical.EncodeValue(canonical.Map{0: header.Kind, 1: append([]byte(nil), header.EntryID[:]...), 2: header.ByteLength, 3: append([]byte(nil), header.ByteDigest[:]...)})
}

func DecodeEntryHeader(encoded []byte) (EntryHeader, error) {
	value, err := canonical.DecodeValue(encoded)
	if err != nil {
		return EntryHeader{}, err
	}
	fields, ok := numericMap(value)
	if !ok || len(fields) != 4 {
		return EntryHeader{}, errors.New("Complete Export entry header must contain the exact fields")
	}
	for index := uint64(0); index < 4; index++ {
		if _, ok := fields[index]; !ok {
			return EntryHeader{}, errors.New("Complete Export entry header omits a field")
		}
	}
	kind, kindOK := uintValue(fields[0])
	entryID, idOK := bytes32(fields[1])
	byteLength, lengthOK := uintValue(fields[2])
	digest, digestOK := bytes32(fields[3])
	if !kindOK || !idOK || !lengthOK || !digestOK {
		return EntryHeader{}, errors.New("Complete Export entry header is invalid")
	}
	header := EntryHeader{Kind: kind, EntryID: entryID, ByteLength: byteLength, ByteDigest: digest}
	canonicalBytes, err := EncodeEntryHeader(header)
	if err != nil || !bytes.Equal(canonicalBytes, encoded) {
		return EntryHeader{}, errors.New("Complete Export entry header is not canonical")
	}
	return header, nil
}

func SequenceEntries(entries []Entry) ([]byte, error) {
	if len(entries) < 2 || entries[0].Header.Kind != ManifestEntryKind || entries[len(entries)-1].Header.Kind != KeyInventoryEntryKind {
		return nil, errors.New("Complete Export must place the Manifest first and Key Inventory last")
	}
	var previousOpaque [32]byte
	havePreviousOpaque := false
	result := bytes.NewBuffer(nil)
	for index, entry := range entries {
		headerBytes, err := EncodeEntryHeader(entry.Header)
		if err != nil {
			return nil, err
		}
		if index > 0 && entry.Header.Kind == ManifestEntryKind {
			return nil, errors.New("Complete Export may contain only one Manifest first")
		}
		if index < len(entries)-1 && entry.Header.Kind == KeyInventoryEntryKind {
			return nil, errors.New("Complete Export Key Inventory must be last")
		}
		if entry.Header.Kind == OpaqueEntryKind {
			if havePreviousOpaque && bytes.Compare(previousOpaque[:], entry.Header.EntryID[:]) >= 0 {
				return nil, errors.New("Complete Export opaque Entry IDs must be sorted unique")
			}
			previousOpaque = entry.Header.EntryID
			havePreviousOpaque = true
		}
		if uint64(len(entry.Bytes)) != entry.Header.ByteLength || sha256.Sum256(entry.Bytes) != entry.Header.ByteDigest {
			return nil, errors.New("Complete Export entry body integrity is invalid")
		}
		identity := EntryIdentity(entry.Header.Kind, entry.Header.ByteLength, entry.Bytes)
		if entry.Header.Kind == OpaqueEntryKind {
			envelope, err := storage.DecodeOpaqueEnvelope(entry.Bytes)
			if err != nil || envelope.StorageItemID != identity {
				return nil, errors.New("Complete Export opaque Entry ID is invalid")
			}
		} else if identity != entry.Header.EntryID {
			return nil, errors.New("Complete Export Entry ID is invalid")
		}
		binary.Write(result, binary.BigEndian, uint32(len(headerBytes)))
		result.Write(headerBytes)
		result.Write(entry.Bytes)
	}
	return result.Bytes(), nil
}

func EntryIdentity(kind, byteLength uint64, body []byte) [32]byte {
	label := "awsm:complete-export-key-inventory-entry-id:v1"
	if kind == ManifestEntryKind {
		label = "awsm:complete-export-manifest-entry-id:v1"
	}
	if kind == OpaqueEntryKind {
		framing := append([]byte("awsm:storage-item-id:v1\x00"), uint32Bytes(1)...)
		length := make([]byte, 8)
		binary.BigEndian.PutUint64(length, byteLength)
		return sha256.Sum256(append(append(append(framing, length...), body...)))
	}
	framing := append([]byte(label+"\x00"), uint32Bytes(1)...)
	length := make([]byte, 8)
	binary.BigEndian.PutUint64(length, byteLength)
	return sha256.Sum256(append(append(append(framing, length...), body...)))
}

func SortEntriesByOpaqueID(entries []Entry) {
	sort.Slice(entries, func(left, right int) bool {
		if entries[left].Header.Kind == OpaqueEntryKind && entries[right].Header.Kind == OpaqueEntryKind {
			return bytes.Compare(entries[left].Header.EntryID[:], entries[right].Header.EntryID[:]) < 0
		}
		return entries[left].Header.Kind < entries[right].Header.Kind
	})
}
