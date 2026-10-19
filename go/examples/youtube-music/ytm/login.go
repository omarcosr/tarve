package ytm

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Google sign-in the way native music clients do it: a real browser window (Chrome or Edge) with a
// throwaway profile; once music.youtube.com holds a signed-in session, its cookies are read over the
// DevTools protocol and the window closes. The user's everyday browser profile is never touched.

const signInURL = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F"

func browserPath() string {
	var candidates []string
	switch runtime.GOOS {
	case "windows":
		var roots []string
		for _, k := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
			if v := os.Getenv(k); v != "" {
				roots = append(roots, v)
			}
		}
		for _, r := range roots {
			candidates = append(candidates, filepath.Join(r, "Google", "Chrome", "Application", "chrome.exe"))
		}
		for _, r := range roots {
			candidates = append(candidates, filepath.Join(r, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	case "darwin":
		candidates = []string{"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"}
	default:
		for _, name := range []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge"} {
			if p, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, p)
			}
		}
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// SignInWithBrowser opens Google's sign-in and returns the music.youtube.com Cookie header.
func SignInWithBrowser(ctx context.Context) (string, error) {
	exe := browserPath()
	if exe == "" {
		return "", errors.New("No Edge or Chrome found; paste your cookies instead.")
	}
	profile, err := os.MkdirTemp("", "tarve-ytm-signin-")
	if err != nil {
		return "", err
	}
	cmd := exec.Command(exe, "--user-data-dir="+profile, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
		"--disable-blink-features=AutomationControlled",
		"--disable-features=Translate,msImplicitSignin,msEdgeSyncConfirmation,msSignInFirstRunExperience",
		"--window-size=520,720", signInURL)
	if err := cmd.Start(); err != nil {
		os.RemoveAll(profile)
		return "", errors.New("The sign-in window did not start.")
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()
	isExited := func() bool {
		select {
		case <-exited:
			return true
		default:
			return false
		}
	}
	var ws *wsConn
	defer func() {
		if ws != nil {
			ws.Close()
		}
		if !isExited() {
			cmd.Process.Kill()
		}
		<-exited
		for i := 0; i < 20; i++ {
			if os.RemoveAll(profile) == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}()
	portFile := filepath.Join(profile, "DevToolsActivePort")
	var lines []string
	for i := 0; ; i++ {
		if data, err := os.ReadFile(portFile); err == nil {
			if lines = strings.Split(strings.TrimSpace(string(data)), "\n"); len(lines) >= 2 {
				break
			}
		}
		if i > 150 || isExited() {
			return "", errors.New("The sign-in window did not start.")
		}
		time.Sleep(100 * time.Millisecond)
	}
	ws, err = dialWebSocket("127.0.0.1:"+strings.TrimSpace(lines[0]), strings.TrimSpace(lines[1]))
	if err != nil {
		return "", errors.New("Cannot reach the sign-in window.")
	}
	replies := make(chan map[string]any, 16)
	go func() {
		for {
			msg, err := ws.Read()
			if err != nil {
				close(replies)
				return
			}
			var m map[string]any
			if json.Unmarshal(msg, &m) == nil {
				replies <- m
			}
		}
	}()
	next := 0
	send := func(method string, timeout time.Duration) (map[string]any, bool) {
		next++
		id := next
		payload, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": map[string]any{}})
		if ws.Write(payload) != nil {
			return nil, false
		}
		deadline := time.After(timeout)
		for {
			select {
			case m, ok := <-replies:
				if !ok {
					return nil, false
				}
				if v, _ := m["id"].(float64); int(v) == id {
					r, _ := m["result"].(map[string]any)
					return r, true
				}
			case <-deadline:
				return nil, true
			}
		}
	}
	for {
		if ctx.Err() != nil {
			return "", errors.New("Sign-in cancelled.")
		}
		if isExited() || ws.closed {
			return "", errors.New("The sign-in window was closed before signing in.")
		}
		result, _ := send("Storage.getCookies", 3*time.Second)
		cookies, _ := result["cookies"].([]any)
		var youtube []string
		found := false
		for _, c := range cookies {
			m, _ := c.(map[string]any)
			domain, _ := m["domain"].(string)
			name, _ := m["name"].(string)
			value, _ := m["value"].(string)
			if domain == ".youtube.com" || strings.HasSuffix(domain, "music.youtube.com") {
				youtube = append(youtube, name+"="+value)
				if name == "SAPISID" || name == "__Secure-3PAPISID" {
					found = true
				}
			}
		}
		if found {
			send("Browser.close", time.Second)
			return strings.Join(youtube, "; "), nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
}

// wsConn is a minimal WebSocket client: text frames, client masking, enough for the DevTools protocol.
type wsConn struct {
	conn   net.Conn
	r      *bufio.Reader
	closed bool
}

func dialWebSocket(host, path string) (*wsConn, error) {
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return nil, err
	}
	var key [16]byte
	rand.Read(key[:])
	k := base64.StdEncoding.EncodeToString(key[:])
	fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", path, host, k)
	r := bufio.NewReader(conn)
	res, err := http.ReadResponse(r, nil)
	if err != nil {
		conn.Close()
		return nil, err
	}
	sum := sha1.Sum([]byte(k + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if res.StatusCode != 101 || res.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) {
		conn.Close()
		return nil, errors.New("websocket handshake failed")
	}
	return &wsConn{conn: conn, r: r}, nil
}

func (w *wsConn) Write(payload []byte) error {
	header := []byte{0x81}
	n := len(payload)
	switch {
	case n < 126:
		header = append(header, byte(0x80|n))
	case n < 1<<16:
		header = append(header, 0x80|126, byte(n>>8), byte(n))
	default:
		header = append(header, 0x80|127)
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}
	var mask [4]byte
	rand.Read(mask[:])
	header = append(header, mask[:]...)
	masked := make([]byte, n)
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	_, err := w.conn.Write(append(header, masked...))
	return err
}

func (w *wsConn) Read() ([]byte, error) {
	var message []byte
	for {
		var h [2]byte
		if _, err := io.ReadFull(w.r, h[:]); err != nil {
			w.closed = true
			return nil, err
		}
		fin, op := h[0]&0x80 != 0, h[0]&0x0f
		n := uint64(h[1] & 0x7f)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(w.r, b[:]); err != nil {
				return nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(w.r, b[:]); err != nil {
				return nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		var mask [4]byte
		masked := h[1]&0x80 != 0
		if masked {
			io.ReadFull(w.r, mask[:])
		}
		data := make([]byte, n)
		if _, err := io.ReadFull(w.r, data); err != nil {
			w.closed = true
			return nil, err
		}
		if masked {
			for i := range data {
				data[i] ^= mask[i%4]
			}
		}
		switch op {
		case 8:
			w.closed = true
			return nil, io.EOF
		case 9, 10:
			continue
		}
		message = append(message, data...)
		if fin {
			return message, nil
		}
	}
}

func (w *wsConn) Close() {
	w.closed = true
	w.conn.Close()
}
