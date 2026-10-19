package tarve

import (
	"errors"
	"runtime"
	"unsafe"

	"github.com/ebitengine/purego"
)

// library holds the C ABI entry points of native/include/tarve.h. Calls go straight through
// purego.SyscallN (no cgo, no reflection wrapper).
type library struct {
	abi, start, send, wait, lastError, join uintptr
	// prewarm is optional (0 in older libraries).
	prewarm uintptr
}

func openLibrary(path string) (*library, error) {
	handle, err := dlopen(path)
	if err != nil {
		return nil, err
	}
	l := &library{}
	for _, s := range []struct {
		name string
		addr *uintptr
	}{
		{"tarve_abi_version", &l.abi}, {"tarve_start", &l.start}, {"tarve_send", &l.send},
		{"tarve_wait_event", &l.wait}, {"tarve_last_error", &l.lastError}, {"tarve_join", &l.join},
	} {
		if *s.addr, err = dlsym(handle, s.name); err != nil {
			return nil, err
		}
	}
	l.prewarm, _ = dlsym(handle, "tarve_prewarm")
	return l, nil
}

func status(r uintptr) int32 { return int32(uint32(r)) }

func (l *library) bytesCall(fn uintptr, b []byte) int32 {
	var p uintptr
	if len(b) > 0 {
		p = uintptr(unsafe.Pointer(unsafe.SliceData(b)))
	}
	r, _, _ := purego.SyscallN(fn, p, uintptr(len(b)))
	runtime.KeepAlive(b)
	return status(r)
}

func (l *library) abiVersion() uint32 {
	r, _, _ := purego.SyscallN(l.abi)
	return uint32(r)
}

func (l *library) err() error {
	buf := make([]byte, 4096)
	if n := l.bytesCall(l.lastError, buf); n > 0 {
		return errors.New(string(buf[:n]))
	}
	return errors.New("tarve: native call failed")
}

func (l *library) call(fn uintptr, payload []byte) error {
	if l.bytesCall(fn, payload) != 0 {
		return l.err()
	}
	return nil
}

// waitEvent blocks until native queues an event; buf grows when an event is larger.
func (l *library) waitEvent(buf []byte) ([]byte, []byte, error) {
	for {
		switch n := l.bytesCall(l.wait, buf); {
		case n < -1:
			buf = make([]byte, -n)
		case n < 0:
			return buf, nil, l.err()
		default:
			return buf, buf[:n], nil
		}
	}
}

func (l *library) joinThread() error {
	r, _, _ := purego.SyscallN(l.join)
	if status(r) != 0 {
		return l.err()
	}
	return nil
}

// prewarmRenderer starts the GPU device on a native thread while Go builds the first document.
func (l *library) prewarmRenderer(renderer string) {
	if l.prewarm == 0 {
		return
	}
	code := uintptr(0)
	switch renderer {
	case "gpu":
		code = 1
	case "cpu":
		code = 2
	}
	purego.SyscallN(l.prewarm, code)
}
