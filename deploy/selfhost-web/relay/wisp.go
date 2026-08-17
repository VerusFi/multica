package main

import (
	"encoding/binary"
	"errors"
)

const (
	TypeConnect  byte = 0x01
	TypeData     byte = 0x02
	TypeContinue byte = 0x03
	TypeClose    byte = 0x04
)

type Frame struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

func (f Frame) Encode() []byte {
	out := make([]byte, 5+len(f.Payload))
	out[0] = f.Type
	binary.LittleEndian.PutUint32(out[1:5], f.StreamID)
	copy(out[5:], f.Payload)
	return out
}

func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < 5 {
		return Frame{}, errors.New("wisp: frame shorter than header")
	}
	return Frame{Type: b[0], StreamID: binary.LittleEndian.Uint32(b[1:5]), Payload: b[5:]}, nil
}

type ConnectPayload struct {
	StreamType byte
	Port       uint16
	Host       string
}

func ParseConnect(b []byte) (ConnectPayload, error) {
	if len(b) < 4 {
		return ConnectPayload{}, errors.New("wisp: connect payload too short")
	}
	return ConnectPayload{StreamType: b[0], Port: binary.LittleEndian.Uint16(b[1:3]), Host: string(b[3:])}, nil
}

func ContinuePayload(remaining uint32) []byte {
	out := make([]byte, 4)
	binary.LittleEndian.PutUint32(out, remaining)
	return out
}
