package tarve

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// LibraryPath resolves the native library like the TypeScript runtime: TARVE_NATIVE, then
// native/bin/current.json in the working directory or any parent (the repository build).
func LibraryPath() (string, error) {
	if path := os.Getenv("TARVE_NATIVE"); path != "" {
		return path, nil
	}
	starts := []string{}
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, dir := range starts {
		for {
			bin := filepath.Join(dir, "native", "bin")
			if data, err := os.ReadFile(filepath.Join(bin, "current.json")); err == nil {
				var manifest struct{ Library string }
				if json.Unmarshal(data, &manifest) == nil && manifest.Library != "" && filepath.Base(manifest.Library) == manifest.Library {
					return filepath.Join(bin, manifest.Library), nil
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", errors.New("tarve: native library not found; set TARVE_NATIVE or run bun run build:native")
}
