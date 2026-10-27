package tarve

import (
	"sync"
)

// Image props: src (path or URL), width, height, fit, style.
// failedImages holds string sources that failed, for Image's fallbackSrc.
var failedImages sync.Map

// ClearFailedImages forgets the failures, so fallbackSrc images try their src again.
func ClearFailedImages() { failedImages.Clear() }

// Image props: src, width, height, fit, style, onError(src, message string) when the source
// fails to load, and fallbackSrc shown instead once a string src failed.
func Image(p Props) *VNode {
	rest := Props{}
	for k, v := range p {
		if k != "width" && k != "height" && k != "style" && k != "fallbackSrc" {
			rest[k] = v
		}
	}
	if fallback, ok := p["fallbackSrc"]; ok && fallback != nil {
		src, _ := p["src"].(string)
		if _, failed := failedImages.Load(src); failed && src != "" {
			rest["src"] = fallback
		} else {
			user, _ := p["onError"].(func(src, message string))
			rest["onError"] = func(failedSrc, message string) {
				if src != "" {
					failedImages.Store(src, true)
				}
				if user != nil {
					user(failedSrc, message)
				}
			}
		}
	}
	rest["style"] = merge(S{"width": p["width"], "height": p["height"], "radius": RadiusMd, "placeholderBackground": T.ImagePlaceholder}, styleOf(p))
	return jsx("image", rest)
}

var inputTypes = set("text", "password", "email", "number", "search", "tel", "url")
