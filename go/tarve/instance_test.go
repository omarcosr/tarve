package tarve

import (
	"fmt"
	"os"
	"testing"
	"time"
)

func TestURLsOfPicksSchemeLinks(t *testing.T) {
	args := []string{"C:\\notes\\a.txt", "myapp://open?x=1", "file:///tmp/a", "https://example.com", "--flag"}
	if got := urlsOf(args, []string{"MyApp"}); len(got) != 1 || got[0] != "myapp://open?x=1" {
		t.Fatalf("schemes: %v", got)
	}
	if got := urlsOf(args, nil); len(got) != 2 {
		t.Fatalf("default: %v", got)
	}
}

func TestSingleInstanceForwardsLaterLaunches(t *testing.T) {
	id := fmt.Sprintf("dev.tarve.go-instance-test-%d-%d", os.Getpid(), time.Now().UnixNano())
	first, err := RequestSingleInstance(SingleInstanceOptions{ID: id, Schemes: []string{"myapp"}})
	if err != nil || !first.Primary {
		t.Fatalf("first: %v %v", first, err)
	}
	got := make(chan InstanceLaunch, 1)
	first.OnSecondInstance(func(l InstanceLaunch) { got <- l })
	address, _ := instanceAddress(id)
	pid, ok := forwardLaunch(address, InstanceLaunch{Args: []string{"myapp://hello", "note.txt"}, Cwd: "/work"}, 2*time.Second)
	if !ok || pid != os.Getpid() {
		t.Fatalf("forward: pid %d ok %v", pid, ok)
	}
	select {
	case l := <-got:
		if len(l.Args) != 2 || l.Cwd != "/work" || len(l.URLs) != 1 || l.URLs[0] != "myapp://hello" {
			t.Fatalf("launch: %+v", l)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first instance heard nothing")
	}
	second, err := RequestSingleInstance(SingleInstanceOptions{ID: id})
	if err != nil || second.Primary {
		t.Fatalf("second: %v %v", second, err)
	}
	first.Release()
	after, err := RequestSingleInstance(SingleInstanceOptions{ID: id})
	if err != nil || !after.Primary {
		t.Fatalf("after release: %v %v", after, err)
	}
	after.Release()
}
