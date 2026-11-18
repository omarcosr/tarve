//go:build !windows

package tarve

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"time"
)

func instanceUser() string {
	if u, err := user.Current(); err == nil {
		return u.Username
	}
	return "user"
}

// instanceAddress is a Unix socket per app and user, in a directory only this user can enter.
func instanceAddress(id string) (string, error) {
	dir, err := privateSocketDirectory()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "tarve-"+instanceKey(id)+".sock"), nil
}

// privateSocketDirectory is $XDG_RUNTIME_DIR (0700 by spec), else a 0700 directory of this user
// under the temporary directory: anyone who can reach the socket could hand the app arguments.
func privateSocketDirectory() (string, error) {
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); runtime != "" {
		if _, err := os.Stat(runtime); err == nil {
			return runtime, nil
		}
	}
	uid := os.Getuid()
	dir := filepath.Join(os.TempDir(), fmt.Sprintf("tarve-%d", uid))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && uid >= 0 && int(st.Uid) != uid {
		return "", fmt.Errorf("%s belongs to another user", dir)
	}
	if info.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func instanceDial(address string, timeout time.Duration) (io.ReadWriteCloser, error) {
	return net.DialTimeout("unix", address, timeout)
}

// removeStaleInstance removes a socket left by a crashed instance (nobody answered on it).
func removeStaleInstance(address string) { os.Remove(address) }

type unixInstanceListener struct {
	net.Listener
	address string
}

func (l unixInstanceListener) Accept() (io.ReadWriteCloser, error) { return l.Listener.Accept() }

func (l unixInstanceListener) Close() error {
	err := l.Listener.Close()
	os.Remove(l.address)
	return err
}

func instanceListen(address string) (instanceListener, error) {
	listener, err := net.Listen("unix", address)
	if err != nil {
		return nil, err
	}
	if ul, ok := listener.(*net.UnixListener); ok {
		ul.SetUnlinkOnClose(false)
	}
	return unixInstanceListener{listener, address}, nil
}

func allowForeground(int) {}
