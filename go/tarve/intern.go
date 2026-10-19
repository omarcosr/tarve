package tarve

import (
	"hash/maphash"
	"math"
)

var hashSeed = maphash.MakeSeed()

func mix(x uint64) uint64 {
	x ^= x >> 33
	x *= 0xff51afd7ed558ccd
	x ^= x >> 33
	x *= 0xc4ceb9fe1a85ec53
	x ^= x >> 33
	return x
}

// hashValue hashes a JSON-like value; maps hash independently of key order and nil entries
// are skipped, so equal values (sameValue) hash equal.
func hashValue(v any) uint64 {
	switch x := v.(type) {
	case string:
		return maphash.String(hashSeed, x)
	case int:
		return mix(math.Float64bits(float64(x)) ^ 0x9e3779b97f4a7c15)
	}
	if f, ok := num(v); ok {
		if f == 0 {
			f = 0
		}
		return mix(math.Float64bits(f) ^ 0x9e3779b97f4a7c15)
	}
	switch x := v.(type) {
	case nil:
		return 1
	case string:
		return maphash.String(hashSeed, x)
	case bool:
		if x {
			return 2
		}
		return 3
	case map[string]any:
		var sum uint64 = 0x51
		for k, e := range x {
			if e == nil {
				continue
			}
			sum += mix(maphash.String(hashSeed, k) ^ (hashValue(e) * 0x100000001b3))
		}
		return mix(sum)
	case []any:
		h := uint64(0x77)
		for _, e := range x {
			h = mix(h ^ hashValue(e))
		}
		return h
	case []string:
		h := uint64(0x78)
		for _, e := range x {
			h = mix(h ^ maphash.String(hashSeed, e))
		}
		return h
	}
	return 4
}

// interned is a style shared by every node with an equal one: compared by pointer, encoded once.
type interned struct {
	style S
	json  []byte
}

type internTable map[uint64][]*interned

func (t internTable) find(h uint64, style S) *interned {
	for _, e := range t[h] {
		if sameValue(map[string]any(e.style), map[string]any(style)) {
			return e
		}
	}
	return nil
}

type resolvedEntry struct {
	raw      S
	resolved S
}

// tables are the compiler's caches: interned styles and fonts, theme-resolved styles, derived node
// styles. A parallel compile worker writes to its own tables and reads the shared ones, which no one
// writes meanwhile; its tables are merged afterwards.
type tables struct {
	theme    *Theme
	styles   internTable
	fonts    internTable
	resolved map[uint64][]*resolvedEntry
	derived  map[derivedKey]*derivedEntry
	size     int
}

func newTables(t *Theme) *tables {
	return &tables{theme: t, styles: internTable{}, fonts: internTable{}, resolved: map[uint64][]*resolvedEntry{}, derived: map[derivedKey]*derivedEntry{}}
}

// shared are the tables kept between renders.
var shared = newTables(LightTheme)

// sharedFor returns the shared tables for theme t, starting over when the theme changes or they grow large.
func sharedFor(t *Theme) *tables {
	if shared.theme != t || shared.size > 1<<16 {
		shared = newTables(t)
	}
	return shared
}

func (c *compiler) intern(which int, style S) *interned {
	h := hashValue(map[string]any(style))
	pick := func(t *tables) internTable {
		if which == 0 {
			return t.styles
		}
		return t.fonts
	}
	if e := pick(c.t).find(h, style); e != nil {
		return e
	}
	if c.base != nil {
		if e := pick(c.base).find(h, style); e != nil {
			return e
		}
	}
	e := &interned{style: style, json: appendValue(nil, map[string]any(style))}
	table := pick(c.t)
	table[h] = append(table[h], e)
	c.t.size++
	return e
}

// resolveEntry is resolveThemeStyle with a cache by value: equal raw styles resolve once per theme.
// The result is shared and must not be modified.
func (c *compiler) resolveEntry(raw S) *resolvedEntry {
	h := hashValue(map[string]any(raw))
	for _, t := range [2]*tables{c.t, c.base} {
		if t == nil {
			continue
		}
		for _, e := range t.resolved[h] {
			if sameValue(map[string]any(e.raw), map[string]any(raw)) {
				return e
			}
		}
	}
	e := &resolvedEntry{raw: merge(raw), resolved: resolveThemeStyle(raw, c.theme)}
	c.t.resolved[h] = append(c.t.resolved[h], e)
	c.t.size++
	return e
}

// absorb merges a worker's tables into t. Styles and fonts already present map to the existing
// entry; remap translates the worker's entries.
func (t *tables) absorb(w *tables) map[*interned]*interned {
	remap := map[*interned]*interned{}
	join := func(dst, src internTable) {
		for h, list := range src {
			for _, e := range list {
				if have := dst.find(h, e.style); have != nil {
					remap[e] = have
				} else {
					dst[h] = append(dst[h], e)
				}
			}
		}
	}
	join(t.styles, w.styles)
	join(t.fonts, w.fonts)
	for h, list := range w.resolved {
		t.resolved[h] = append(t.resolved[h], list...)
	}
	for k, d := range w.derived {
		if f := remap[k.font]; f != nil {
			k.font = f
		}
		if s := remap[d.style]; s != nil {
			d.style = s
		}
		if f := remap[d.childFont]; f != nil {
			d.childFont = f
		}
		if _, ok := t.derived[k]; !ok {
			t.derived[k] = d
		}
	}
	t.size += w.size
	return remap
}
