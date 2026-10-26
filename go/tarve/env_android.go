//go:build android

package tarve

import (
	"os"
	"unsafe"

	"github.com/ebitengine/purego"
)

// On Android a Go app is a library the Tarve runtime loads (libtarveapp.so, see
// native/src/android.rs). Go copied the environment when the process started, before
// android_main set TARVE_NATIVE, HOME, TMPDIR and LANG, so read those from libc.
func init() {
	libc, err := purego.Dlopen("libc.so", purego.RTLD_NOW)
	if err != nil {
		return
	}
	getenv, err := purego.Dlsym(libc, "getenv")
	if err != nil {
		return
	}
	for _, key := range []string{"TARVE_NATIVE", "HOME", "TMPDIR", "LANG"} {
		name := append([]byte(key), 0)
		value, _, _ := purego.SyscallN(getenv, uintptr(unsafe.Pointer(unsafe.SliceData(name))))
		if value != 0 {
			os.Setenv(key, cString(value))
		}
	}
}

// cString copies a NUL-terminated C string that libc owns.
func cString(address uintptr) string {
	start := *(**byte)(unsafe.Pointer(&address))
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(start), length)) != 0 {
		length++
	}
	return string(unsafe.Slice(start, length))
}
