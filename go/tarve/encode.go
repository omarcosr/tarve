package tarve

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"
)

const hexDigits = "0123456789abcdef"

// appendString appends s as a JSON string.
func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < utf8.RuneSelf {
			i++
			continue
		}
		if c >= utf8.RuneSelf {
			r, size := utf8.DecodeRuneInString(s[i:])
			if r == utf8.RuneError && size == 1 {
				b = append(b, s[start:i]...)
				b = append(b, "\\ufffd"...)
				i++
				start = i
				continue
			}
			if r == '\u2028' || r == '\u2029' {
				b = append(b, s[start:i]...)
				b = append(b, '\\', 'u', '2', '0', '2', hexDigits[r&0xf])
				i += size
				start = i
				continue
			}
			i += size
			continue
		}
		b = append(b, s[start:i]...)
		switch c {
		case '"', '\\':
			b = append(b, '\\', c)
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
		}
		i++
		start = i
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}

func appendNumber(b []byte, f float64) []byte {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return append(b, "null"...)
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.AppendInt(b, int64(f), 10)
	}
	return strconv.AppendFloat(b, f, 'g', -1, 64)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// appendValue appends a JSON-like Go value; nil map entries are skipped, as undefined is.
func appendValue(b []byte, v any) []byte {
	if f, ok := num(v); ok {
		return appendNumber(b, f)
	}
	switch x := v.(type) {
	case nil, jsonNull:
		return append(b, "null"...)
	case string:
		return appendString(b, x)
	case bool:
		if x {
			return append(b, "true"...)
		}
		return append(b, "false"...)
	case *NNode:
		return appendNode(b, x, true)
	case map[string]any:
		b = append(b, '{')
		first := true
		for _, k := range sortedKeys(x) {
			if x[k] == nil {
				continue
			}
			if !first {
				b = append(b, ',')
			}
			first = false
			b = appendString(b, k)
			b = append(b, ':')
			b = appendValue(b, x[k])
		}
		return append(b, '}')
	case map[string]string:
		b = append(b, '{')
		for i, k := range sortedKeys(x) {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendString(b, k)
			b = append(b, ':')
			b = appendString(b, x[k])
		}
		return append(b, '}')
	case []any:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendValue(b, e)
		}
		return append(b, ']')
	case []string:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendString(b, e)
		}
		return append(b, ']')
	case []float64:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendNumber(b, e)
		}
		return append(b, ']')
	case []map[string]any:
		b = append(b, '[')
		for i, e := range x {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendValue(b, e)
		}
		return append(b, ']')
	}
	panic("tarve: cannot encode " + strconv.Quote(typeName(v)))
}

type jsonNull struct{}

func typeName(v any) string { return fmt.Sprintf("%T", v) }

// appendNode appends the node's wire object; deep includes its subtree, otherwise children is [].
func appendNode(b []byte, n *NNode, deep bool) []byte {
	b = append(b, `{"id":`...)
	b = appendString(b, n.ID)
	b = append(b, `,"kind":`...)
	b = appendString(b, n.Kind)
	b = append(b, `,"style":`...)
	if n.style != nil {
		b = append(b, n.style.json...)
	} else {
		b = appendValue(b, map[string]any(n.Style))
	}
	var buf [16]string
	keys := buf[:0]
	for k := range n.F {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	for _, k := range keys {
		if n.F[k] == nil {
			continue
		}
		b = append(b, ',')
		b = appendString(b, k)
		b = append(b, ':')
		b = appendValue(b, n.F[k])
	}
	b = append(b, `,"children":[`...)
	if deep {
		for i, c := range n.Children {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendNode(b, c, true)
		}
	}
	return append(b, "]}"...)
}
