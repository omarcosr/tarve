package tarve

import (
	"errors"
	"log"
)

func (a *App) reportError(source string, err error) {
	if a.options.OnError != nil {
		a.options.OnError(source, err)
		return
	}
	log.Printf("[tarve] %s: %v", source, err)
}

// nativeError reports a native error event; one with "fatal": true ended the app, and Run returns it.
func (a *App) nativeError(ev map[string]any) {
	msg, _ := ev["message"].(string)
	err := errors.New(msg)
	if fatal, _ := ev["fatal"].(bool); fatal && a.fatal == nil {
		a.fatal = err
	}
	a.reportError("native", err)
}
