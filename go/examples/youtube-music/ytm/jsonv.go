package ytm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// obj is a JSON object that keeps its key order, as JavaScript objects do: InnerTube's
// "first match in document order" lookups depend on it.
type obj struct {
	keys []string
	m    map[string]any
}

func decodeOrdered(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := decodeValue(d)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return v, nil
	}
	return v, nil
}

func decodeValue(d *json.Decoder) (any, error) {
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch x := t.(type) {
	case json.Delim:
		switch x {
		case '{':
			o := &obj{m: map[string]any{}}
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				k := kt.(string)
				v, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				if _, seen := o.m[k]; !seen {
					o.keys = append(o.keys, k)
				}
				o.m[k] = v
			}
			_, err := d.Token()
			return o, err
		case '[':
			list := []any{}
			for d.More() {
				v, err := decodeValue(d)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := d.Token()
			return list, err
		}
	case json.Number:
		f, _ := x.Float64()
		return f, nil
	}
	return t, nil
}

// get walks keys through nested objects (optional chaining); nil when any step is missing.
func get(v any, keys ...any) any {
	for _, k := range keys {
		switch key := k.(type) {
		case string:
			o, ok := v.(*obj)
			if !ok || o == nil {
				return nil
			}
			v = o.m[key]
		case int:
			list, ok := v.([]any)
			if !ok {
				return nil
			}
			if key < 0 {
				key += len(list)
			}
			if key < 0 || key >= len(list) {
				return nil
			}
			v = list[key]
		}
	}
	return v
}

func gstr(v any, keys ...any) string {
	switch x := get(v, keys...).(type) {
	case string:
		return x
	case float64:
		return fmt.Sprint(x)
	case bool:
		return fmt.Sprint(x)
	}
	return ""
}

// findAll is every value under key anywhere in node, in document order (not descending into matches).
func findAll(node any, key string, out []any) []any {
	switch x := node.(type) {
	case []any:
		for _, c := range x {
			out = findAll(c, key, out)
		}
	case *obj:
		for _, k := range x.keys {
			if k == key {
				out = append(out, x.m[k])
			} else {
				out = findAll(x.m[k], key, out)
			}
		}
	}
	return out
}

func first(node any, key string) any {
	all := findAll(node, key, nil)
	if len(all) == 0 {
		return nil
	}
	return all[0]
}
