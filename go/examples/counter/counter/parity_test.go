package counter

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/tarve/tarve-go/tarve"
)

// TestParityWithTypeScript compares the native documents with examples/counter/counter.tsx's.
func TestParityWithTypeScript(t *testing.T) {
	type event struct {
		ID      string `json:"id"`
		Handler string `json:"handler"`
		Args    []any  `json:"args,omitempty"`
	}
	type scenario struct {
		Name   string         `json:"name"`
		State  map[string]any `json:"state"`
		Events []event        `json:"events,omitempty"`
	}
	scenarios := []scenario{
		{Name: "initial", State: map[string]any{}},
		{Name: "counted", State: map[string]any{"count": 7, "status": "Opened: C:\\notes.txt"}},
		{Name: "unprotected", State: map[string]any{"protectClose": false, "count": -3}},
		{Name: "click-increase", State: map[string]any{}, Events: []event{{ID: "root/children/1/children/2/children/1", Handler: "onClick"}, {ID: "root/children/1/children/2/children/1", Handler: "onClick"}}},
		{Name: "click-decrease-and-toggle", State: map[string]any{}, Events: []event{{ID: "root/children/1/children/2/children/0", Handler: "onClick"}, {ID: "root/children/1/children/5", Handler: "onClick"}}},
	}
	dir, _ := filepath.Abs("../../../..")
	file := filepath.Join(t.TempDir(), "scenarios.json")
	data, _ := json.Marshal(scenarios)
	os.WriteFile(file, data, 0o644)
	cmd := exec.Command("bun", filepath.Join("go", "parity", "dump.tsx"), "counter", file)
	cmd.Dir = dir
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
	for i, sc := range scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			State.Count, State.Status, State.ProtectClose = 0, "Ctrl+S is registered as a global app hotkey.", true
			if v, ok := sc.State["count"].(int); ok {
				State.Count = v
			}
			if v, ok := sc.State["status"].(string); ok {
				State.Status = v
			}
			if v, ok := sc.State["protectClose"].(bool); ok {
				State.ProtectClose = v
			}
			r := tarve.NewTestRenderer(Render)
			doc := r.Render()
			for _, ev := range sc.Events {
				if err := r.Fire(ev.ID, ev.Handler, ev.Args...); err != nil {
					t.Fatal(err)
				}
				doc = r.Render()
			}
			var got any
			json.Unmarshal(doc, &got)
			if !reflect.DeepEqual(want[i].Document, got) {
				a, _ := json.MarshalIndent(want[i].Document, "", " ")
				b, _ := json.MarshalIndent(got, "", " ")
				t.Errorf("documents differ\nts: %s\ngo: %s", a, b)
			}
		})
	}
}
