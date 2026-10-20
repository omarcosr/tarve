package ytm

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/omarcosr/tarve/go/tarve"
)

// diff lists where two JSON values differ (up to limit).
func diff(path string, a, b any, out *[]string, limit int) {
	if len(*out) >= limit {
		return
	}
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: ts %v, go %v", path, short(a), short(b)))
			return
		}
		keys := map[string]bool{}
		for k := range x {
			keys[k] = true
		}
		for k := range y {
			keys[k] = true
		}
		list := make([]string, 0, len(keys))
		for k := range keys {
			list = append(list, k)
		}
		sort.Strings(list)
		for _, k := range list {
			sub := path + "." + k
			if id, ok := x["id"].(string); ok && k == "children" {
				sub = path + "[" + id + "].children"
			}
			diff(sub, x[k], y[k], out, limit)
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			*out = append(*out, fmt.Sprintf("%s: ts %v, go %v", path, short(a), short(b)))
			return
		}
		for i := range x {
			diff(fmt.Sprintf("%s[%d]", path, i), x[i], y[i], out, limit)
		}
	default:
		if fmt.Sprint(a) != fmt.Sprint(b) {
			*out = append(*out, fmt.Sprintf("%s: ts %v, go %v", path, short(a), short(b)))
		}
	}
}

func short(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	return s
}

func repoRoot(t *testing.T) string {
	dir, _ := filepath.Abs(".")
	for {
		if _, err := os.Stat(filepath.Join(dir, "go", "parity", "dump.tsx")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Skip("repository root not found")
		}
		dir = parent
	}
}

// TestParityWithTypeScript renders every scenario with the TypeScript view and with this one,
// and requires the same native document.
func TestParityWithTypeScript(t *testing.T) {
	root := repoRoot(t)
	scenarios, _ := filepath.Abs("testdata/scenarios.json")
	cmd := exec.Command("bun", filepath.Join("go", "parity", "dump.tsx"), "ytm", scenarios)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Skipf("bun unavailable: %v", err)
	}
	var want []struct {
		Name     string
		Document any
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	var input []struct {
		Name   string
		State  json.RawMessage
		Events []struct {
			ID, Handler string
			Args        []any
		}
	}
	data, _ := os.ReadFile(scenarios)
	json.Unmarshal(data, &input)
	for i, sc := range input {
		t.Run(sc.Name, func(t *testing.T) {
			s := NewState()
			if err := json.Unmarshal(sc.State, s); err != nil {
				t.Fatal(err)
			}
			SetState(s)
			r := tarve.NewTestRenderer(func() tarve.Child { return YouTubeMusicView() })
			doc := r.Render()
			for _, ev := range sc.Events {
				if err := r.Fire(ev.ID, ev.Handler, ev.Args...); err != nil {
					t.Fatal(err)
				}
				doc = r.Render()
			}
			var got any
			json.Unmarshal(doc, &got)
			var out []string
			diff("", want[i].Document, got, &out, 25)
			if len(out) > 0 {
				t.Errorf("%d+ differences:\n%s", len(out), strings.Join(out, "\n"))
			}
		})
	}
}
