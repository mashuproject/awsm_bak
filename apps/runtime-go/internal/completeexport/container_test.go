package completeexport

import (
	"bytes"
	"testing"
)

func TestCompleteExportContainerRoundTripsCanonicalFrames(t *testing.T) {
	salt := [16]byte{}
	nonce := [24]byte{}
	for index := range salt {
		salt[index] = byte(index)
	}
	for index := range nonce {
		nonce[index] = byte(0x20 + index)
	}
	prefixBytes, err := EncodePrefix(salt, nonce)
	if err != nil {
		t.Fatalf("encode prefix: %v", err)
	}
	prefix, err := DecodePrefix(prefixBytes)
	if err != nil {
		t.Fatalf("decode prefix: %v", err)
	}
	if !bytes.Equal(prefix.Salt[:], salt[:]) || !bytes.Equal(prefix.Nonce[:], nonce[:]) {
		t.Fatal("prefix nonce or salt changed")
	}
	key, err := DeriveKey("correct horse battery staple", prefix)
	if err != nil {
		t.Fatalf("derive key: %v", err)
	}
	plaintext := []byte("portable vault bytes")
	frame, err := SealFrame(key, prefix.Bytes, prefix.Nonce, 7, true, plaintext)
	if err != nil {
		t.Fatalf("seal frame: %v", err)
	}
	opened, err := OpenFrame(key, prefix.Bytes, prefix.Nonce, frame, 7)
	if err != nil {
		t.Fatalf("open frame: %v", err)
	}
	if !opened.Final || !bytes.Equal(opened.Plaintext, plaintext) {
		t.Fatalf("opened frame = %#v", opened)
	}
	stream, err := SealStream("correct horse battery staple", salt, nonce, bytes.Repeat([]byte{0x5a}, FramePlaintextLimit+17))
	if err != nil {
		t.Fatalf("seal stream: %v", err)
	}
	openedStream, err := OpenStream("correct horse battery staple", stream)
	if err != nil {
		t.Fatalf("open stream: %v", err)
	}
	if openedStream.FrameCount != 2 || !bytes.Equal(openedStream.Plaintext, bytes.Repeat([]byte{0x5a}, FramePlaintextLimit+17)) {
		t.Fatalf("opened stream did not preserve bytes")
	}
}

func TestCompleteExportContainerRejectsNonFinalShortFrames(t *testing.T) {
	salt := [16]byte{}
	nonce := [24]byte{}
	prefixBytes, err := EncodePrefix(salt, nonce)
	if err != nil {
		t.Fatalf("encode prefix: %v", err)
	}
	prefix, err := DecodePrefix(prefixBytes)
	if err != nil {
		t.Fatalf("decode prefix: %v", err)
	}
	key, err := DeriveKey("password", prefix)
	if err != nil {
		t.Fatalf("derive key: %v", err)
	}
	if _, err := SealFrame(key, prefix.Bytes, prefix.Nonce, 0, false, []byte{1}); err == nil {
		t.Fatal("short non-final frame was accepted")
	}
}
