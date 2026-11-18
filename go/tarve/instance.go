package tarve

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// InstanceLaunch is how the app was launched: its arguments, working directory and the URLs
// among them (@tarve/core InstanceLaunch; the same JSON crosses the instance pipe).
type InstanceLaunch struct {
	Args []string `json:"args"`
	Cwd  string   `json:"cwd"`
	// URLs are the arguments that are links of the app's schemes (myapp://…).
	URLs []string `json:"urls"`
}

// SingleInstanceOptions mirror @tarve/core SingleInstanceOptions.
type SingleInstanceOptions struct {
	// ID names the app across processes; default the executable's file name. Use the same id as
	// a TypeScript build of the app (package.json tarve.appId) to share its first instance.
	ID string
	// Schemes whose links are picked out of the arguments; default every scheme:// argument.
	Schemes []string
}

// SingleInstance is the result of RequestSingleInstance.
type SingleInstance struct {
	// Primary is true for the app's first instance. When false, this launch went to that one: exit.
	Primary bool
	// Launch is this launch (arguments after the program, working directory, URLs).
	Launch InstanceLaunch

	mu        sync.Mutex
	listeners map[int]func(InstanceLaunch)
	nextID    int
	release   func()
}

// OnSecondInstance hears another launch of the app (opening a file or a link, a second click on
// the icon) forwarded here. It runs on the listener's goroutine: touch the UI through App.Post.
// The returned function stops listening.
func (s *SingleInstance) OnSecondInstance(listener func(InstanceLaunch)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listeners == nil {
		s.listeners = map[int]func(InstanceLaunch){}
	}
	id := s.nextID
	s.nextID++
	s.listeners[id] = listener
	return func() {
		s.mu.Lock()
		delete(s.listeners, id)
		s.mu.Unlock()
	}
}

// Release stops answering later launches (they become first instances themselves).
func (s *SingleInstance) Release() {
	if s.release != nil {
		s.release()
	}
}

func (s *SingleInstance) deliver(launch InstanceLaunch) {
	s.mu.Lock()
	listeners := make([]func(InstanceLaunch), 0, len(s.listeners))
	for _, l := range s.listeners {
		listeners = append(listeners, l)
	}
	s.mu.Unlock()
	for _, l := range listeners {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[tarve] OnSecondInstance: %v", r)
				}
			}()
			l(launch)
		}()
	}
}

var urlArgument = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]+):`)

// urlsOf picks the arguments that are URLs of schemes (default: every scheme:// argument).
func urlsOf(args []string, schemes []string) []string {
	urls := []string{}
	for _, arg := range args {
		m := urlArgument.FindStringSubmatch(arg)
		if m == nil || strings.EqualFold(m[1], "file") {
			continue
		}
		if len(schemes) == 0 {
			if strings.Contains(arg, "://") {
				urls = append(urls, arg)
			}
			continue
		}
		for _, scheme := range schemes {
			if strings.EqualFold(scheme, m[1]) {
				urls = append(urls, arg)
				break
			}
		}
	}
	return urls
}

// instanceKey is the per-app, per-user part of the address, the same as instance.ts derives.
func instanceKey(id string) string {
	sum := sha256.Sum256([]byte(id + "\x00" + instanceUser()))
	return hex.EncodeToString(sum[:])[:24]
}

func defaultInstanceID() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Base(exe)
	}
	return filepath.Base(os.Args[0])
}

// answeredPid is the pid in a first instance's answer, when it is a positive integer.
func answeredPid(answer string) int {
	pid, err := strconv.Atoi(strings.TrimSpace(answer))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// forwardLaunch hands this launch to a running first instance: answered is false when none answers.
func forwardLaunch(address string, launch InstanceLaunch, timeout time.Duration) (pid int, answered bool) {
	conn, err := instanceDial(address, timeout)
	if err != nil {
		return 0, false
	}
	type result struct {
		pid int
		ok  bool
	}
	done := make(chan result, 1)
	go func() {
		payload, _ := json.Marshal(launch)
		if _, err := conn.Write(append(payload, '\n')); err != nil {
			done <- result{}
			return
		}
		line, err := bufio.NewReader(conn).ReadString('\n')
		if err != nil {
			done <- result{}
			return
		}
		done <- result{answeredPid(line), true}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case r := <-done:
		conn.Close()
		return r.pid, r.ok
	case <-timer.C:
		conn.Close()
		return 0, false
	}
}

// serveLaunch answers one later launch: the pid first (so it can let this process take the
// foreground), then the launch goes to deliver.
func serveLaunch(conn io.ReadWriteCloser, deliver func(InstanceLaunch)) {
	defer conn.Close()
	line, err := bufio.NewReader(io.LimitReader(conn, 1<<20)).ReadString('\n')
	if err != nil {
		return
	}
	if _, err := io.WriteString(conn, strconv.Itoa(os.Getpid())+"\n"); err != nil {
		return
	}
	var raw struct {
		Args []any `json:"args"`
		Cwd  any   `json:"cwd"`
	}
	if json.Unmarshal([]byte(line), &raw) != nil || raw.Args == nil {
		return
	}
	launch := InstanceLaunch{Args: make([]string, 0, len(raw.Args))}
	for _, arg := range raw.Args {
		s, ok := arg.(string)
		if !ok {
			return
		}
		launch.Args = append(launch.Args, s)
	}
	launch.Cwd, _ = raw.Cwd.(string)
	deliver(launch)
}

// RequestSingleInstance keeps the app to one process per user, like @tarve/core's
// requestSingleInstance: the first launch gets Primary true and hears later ones through
// OnSecondInstance; a later launch hands its arguments (files, links) to the first, gets
// Primary false and should exit. Call it before CreateApp. The first instance answers until
// Release or until the process exits.
//
//	instance, err := tarve.RequestSingleInstance(tarve.SingleInstanceOptions{Schemes: []string{"myapp"}})
//	if err != nil { log.Fatal(err) }
//	if !instance.Primary { return }
//	app, _ := tarve.CreateApp(view, options)
//	instance.OnSecondInstance(func(l tarve.InstanceLaunch) { app.Post(func() { open(l.URLs) }) })
func RequestSingleInstance(options SingleInstanceOptions) (*SingleInstance, error) {
	cwd, _ := os.Getwd()
	args := append([]string{}, os.Args[1:]...)
	s := &SingleInstance{Launch: InstanceLaunch{Args: args, Cwd: cwd, URLs: urlsOf(args, options.Schemes)}}
	// Android starts one process per app and brings its activity back on a later launch.
	if runtime.GOOS == "android" {
		s.Primary = true
		return s, nil
	}
	id := options.ID
	if id == "" {
		id = defaultInstanceID()
	}
	address, err := instanceAddress(id)
	if err != nil {
		return nil, err
	}
	deliver := func(next InstanceLaunch) {
		next.URLs = urlsOf(next.Args, options.Schemes)
		s.deliver(next)
	}
	// A first instance that was just killed or is still quitting can leave its pipe or socket
	// behind for a while: retry with a growing pause (about 10 s) instead of giving up early.
	deadline := time.Now().Add(10 * time.Second)
	for attempt := 0; attempt < 2 || time.Now().Before(deadline); attempt++ {
		if attempt > 1 {
			time.Sleep(min(50*time.Millisecond<<(attempt-2), 800*time.Millisecond))
		}
		if pid, ok := forwardLaunch(address, s.Launch, 2*time.Second); ok {
			if pid > 0 {
				allowForeground(pid)
			}
			return s, nil
		}
		removeStaleInstance(address)
		listener, err := instanceListen(address)
		if err != nil {
			// Another first launch won the race to listen: hand the launch to it.
			continue
		}
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				go serveLaunch(conn, deliver)
			}
		}()
		var once sync.Once
		s.Primary = true
		s.release = func() { once.Do(func() { listener.Close() }) }
		return s, nil
	}
	return nil, errors.New("tarve: could not reach or become the app's first instance")
}

// instanceListener accepts the connections of later launches.
type instanceListener interface {
	Accept() (io.ReadWriteCloser, error)
	Close() error
}
