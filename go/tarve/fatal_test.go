package tarve

import (
	"strings"
	"testing"
)

// scriptedBridge hands out fixed native events, one per wait, then reports the queue closed.
type scriptedBridge struct{ events []string }

func (b *scriptedBridge) start([]byte) error { return nil }
func (b *scriptedBridge) send([]byte) error  { return nil }
func (b *scriptedBridge) join() error        { return nil }
func (b *scriptedBridge) wait(buf []byte) ([]byte, []byte, error) {
	if len(b.events) == 0 {
		select {}
	}
	next := b.events[0]
	b.events = b.events[1:]
	return buf, []byte(next), nil
}

func runScripted(t *testing.T, events ...string) (error, []string) {
	t.Helper()
	var reported []string
	view := func() Child { return Window(Props{"title": "t"}, Text(nil, "hi")) }
	a, err := startApp(view, Options{OnError: func(source string, err error) { reported = append(reported, source+": "+err.Error()) }}, &scriptedBridge{events: events})
	if err != nil {
		t.Fatal(err)
	}
	return a.Run(), reported
}

func TestRunReturnsTheFatalErrorThatEndedTheApp(t *testing.T) {
	err, reported := runScripted(t, `{"type":"ready"}`, `{"type":"error","message":"GPU device lost","fatal":true}`, `{"type":"closed"}`)
	if err == nil || !strings.Contains(err.Error(), "GPU device lost") {
		t.Fatalf("Run() = %v, want the fatal error", err)
	}
	if len(reported) != 1 || reported[0] != "native: GPU device lost" {
		t.Fatalf("reported %v", reported)
	}
}

func TestRunReturnsNilAfterANormalCloseEvenWithPlainErrors(t *testing.T) {
	err, reported := runScripted(t, `{"type":"ready"}`, `{"type":"error","message":"window icon: bad png"}`, `{"type":"closed"}`)
	if err != nil {
		t.Fatalf("Run() = %v, want nil", err)
	}
	if len(reported) != 1 {
		t.Fatalf("reported %v", reported)
	}
}
