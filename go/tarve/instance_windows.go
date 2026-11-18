//go:build windows

package tarve

import (
	"errors"
	"io"
	"os/user"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	instanceKernel32          = syscall.NewLazyDLL("kernel32.dll")
	procCreateNamedPipeW      = instanceKernel32.NewProc("CreateNamedPipeW")
	procConnectNamedPipe      = instanceKernel32.NewProc("ConnectNamedPipe")
	procDisconnectNamedPipe   = instanceKernel32.NewProc("DisconnectNamedPipe")
	procWaitNamedPipeW        = instanceKernel32.NewProc("WaitNamedPipeW")
	procAllowSetForegroundWnd = syscall.NewLazyDLL("user32.dll").NewProc("AllowSetForegroundWindow")
)

const (
	pipeAccessDuplex          = 0x3
	fileFlagFirstPipeInstance = 0x80000
	pipeRejectRemoteClients   = 0x8
	pipeUnlimitedInstances    = 255
	errorPipeBusy             = syscall.Errno(231)
	errorPipeConnected        = syscall.Errno(535)
)

var errInstanceListenerClosed = errors.New("tarve: instance listener closed")

// instanceUser is the user name alone, as Node.js os.userInfo() gives it (no domain).
func instanceUser() string {
	if u, err := user.Current(); err == nil {
		name := u.Username
		if i := strings.LastIndexByte(name, '\\'); i >= 0 {
			name = name[i+1:]
		}
		return name
	}
	return "user"
}

// instanceAddress is a named pipe per app and user, the one instance.ts listens on.
func instanceAddress(id string) (string, error) {
	return `\\.\pipe\tarve-` + instanceKey(id), nil
}

func removeStaleInstance(string) {}

// allowForeground lets the first instance take the foreground for the launch handed to it.
func allowForeground(pid int) { procAllowSetForegroundWnd.Call(uintptr(pid)) }

type pipeConn struct {
	h      syscall.Handle
	server bool
	once   sync.Once
}

func (c *pipeConn) Read(b []byte) (int, error) {
	var n uint32
	err := syscall.ReadFile(c.h, b, &n, nil)
	if err == syscall.ERROR_BROKEN_PIPE || (err == nil && n == 0 && len(b) > 0) {
		return int(n), io.EOF
	}
	return int(n), err
}

func (c *pipeConn) Write(b []byte) (int, error) {
	var n uint32
	err := syscall.WriteFile(c.h, b, &n, nil)
	return int(n), err
}

func (c *pipeConn) Close() error {
	var err error
	c.once.Do(func() {
		if c.server {
			// The client reads the answer before the pipe goes away.
			syscall.FlushFileBuffers(c.h)
			procDisconnectNamedPipe.Call(uintptr(c.h))
		} else {
			syscall.CancelIoEx(c.h, nil)
		}
		err = syscall.CloseHandle(c.h)
	})
	return err
}

func instanceDial(address string, timeout time.Duration) (io.ReadWriteCloser, error) {
	name, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_EXISTING, 0, 0)
		if err == nil {
			return &pipeConn{h: h}, nil
		}
		if err != errorPipeBusy || time.Now().After(deadline) {
			return nil, err
		}
		procWaitNamedPipeW.Call(uintptr(unsafe.Pointer(name)), 100)
	}
}

func createInstancePipe(name *uint16, first bool) (syscall.Handle, error) {
	mode := uintptr(pipeAccessDuplex)
	if first {
		mode |= fileFlagFirstPipeInstance
	}
	r, _, err := procCreateNamedPipeW.Call(uintptr(unsafe.Pointer(name)), mode, pipeRejectRemoteClients, pipeUnlimitedInstances, 4096, 4096, 0, 0)
	if h := syscall.Handle(r); h != syscall.InvalidHandle {
		return h, nil
	}
	return 0, err
}

// pipeListener always keeps one pipe instance waiting, so a later launch never finds it busy.
type pipeListener struct {
	address string
	name    *uint16
	mu      sync.Mutex
	next    syscall.Handle
	closed  bool
}

func instanceListen(address string) (instanceListener, error) {
	name, err := syscall.UTF16PtrFromString(address)
	if err != nil {
		return nil, err
	}
	// FILE_FLAG_FIRST_PIPE_INSTANCE fails when another process already listens there.
	h, err := createInstancePipe(name, true)
	if err != nil {
		return nil, err
	}
	return &pipeListener{address: address, name: name, next: h}, nil
}

func (l *pipeListener) Accept() (io.ReadWriteCloser, error) {
	for {
		l.mu.Lock()
		h, closed := l.next, l.closed
		l.mu.Unlock()
		if closed {
			return nil, errInstanceListenerClosed
		}
		r, _, err := procConnectNamedPipe.Call(uintptr(h), 0)
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			syscall.CloseHandle(h)
			return nil, errInstanceListenerClosed
		}
		next, cerr := createInstancePipe(l.name, false)
		if cerr != nil {
			l.closed = true
			l.mu.Unlock()
			syscall.CloseHandle(h)
			return nil, cerr
		}
		l.next = next
		l.mu.Unlock()
		if r == 0 && err != errorPipeConnected {
			procDisconnectNamedPipe.Call(uintptr(h))
			syscall.CloseHandle(h)
			continue
		}
		return &pipeConn{h: h, server: true}, nil
	}
}

// Close wakes the pending ConnectNamedPipe by connecting to it, then Accept closes the pipe.
func (l *pipeListener) Close() error {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return nil
	}
	l.closed = true
	l.mu.Unlock()
	if conn, err := instanceDial(l.address, 500*time.Millisecond); err == nil {
		conn.Close()
	}
	return nil
}
