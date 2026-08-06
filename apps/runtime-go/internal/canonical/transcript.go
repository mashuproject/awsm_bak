package canonical

import (
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
)

var transcriptLabel = regexp.MustCompile(`^awsm:[a-z0-9:-]+:v1$`)

func Transcript(label string, parts ...[]byte) ([]byte, error) {
	if !transcriptLabel.MatchString(label) {
		return nil, errors.New("invalid transcript label")
	}
	if uint64(len(parts)) > uint64(^uint32(0)) {
		return nil, errors.New("too many transcript parts")
	}
	total := len(label) + 1 + 4
	for _, part := range parts {
		if uint64(len(part)) > ^uint64(0)-8 {
			return nil, errors.New("transcript part is too large")
		}
		total += 8 + len(part)
	}
	result := make([]byte, total)
	offset := copy(result, label)
	result[offset] = 0
	offset++
	binary.BigEndian.PutUint32(result[offset:], uint32(len(parts)))
	offset += 4
	for _, part := range parts {
		binary.BigEndian.PutUint64(result[offset:], uint64(len(part)))
		offset += 8
		offset += copy(result[offset:], part)
	}
	if offset != len(result) {
		return nil, fmt.Errorf("transcript framing wrote %d bytes of %d", offset, len(result))
	}
	return result, nil
}
