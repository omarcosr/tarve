package tarve

import (
	"reflect"
	"testing"
)

func TestParseTransformPercentIsOfTheOwnBox(t *testing.T) {
	cases := map[string]S{
		"translateX(-100%)":             {"xPercent": -100.0},
		"scale(2) translate(10px, 50%)": {"x": 20.0, "yPercent": 100.0, "scale": 2.0},
		"translateY(-2px) scale(1.02)":  {"y": -2.0, "scale": 1.02},
	}
	for input, want := range cases {
		if got := parseTransform(input); !reflect.DeepEqual(got, want) {
			t.Errorf("parseTransform(%q) = %v, want %v", input, got, want)
		}
	}
}
