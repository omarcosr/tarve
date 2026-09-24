#ifndef TARVE_H
#define TARVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* All pointers refer to caller-owned buffers valid only for the duration of a call.
   Never unload the DLL until tarve_join has returned.
   Exactly one start per process (Winit's event loop lifecycle). */
uint32_t tarve_abi_version(void);
/* UTF-8 JSON document/command, explicit byte length, no NUL terminator. 0 = success. */
int32_t tarve_start(const uint8_t *json, uint32_t length);
int32_t tarve_send(const uint8_t *json, uint32_t length);
/* UTF-8 Windows named-pipe path used only as an event-loop wake signal.
   Positive = bytes copied; < -1 = required capacity; -1 = error. */
int32_t tarve_event_pipe_name(uint8_t *buffer, uint32_t capacity);
/* Legacy blocking wait. Positive = bytes copied; < -1 = required capacity (event retained).
   -1 = error. The current Bun bridge uses the named pipe above plus non-blocking dequeue below. */
int32_t tarve_wait_event(uint8_t *buffer, uint32_t capacity);
/* Non-blocking dequeue. Positive = bytes copied; < -1 = required capacity; 0 = empty. */
int32_t tarve_poll_event(uint8_t *buffer, uint32_t capacity);
int32_t tarve_last_error(uint8_t *buffer, uint32_t capacity);
/* Call after receiving closed. Joins the native window thread. */
int32_t tarve_join(void);
#ifdef __cplusplus
}
#endif
#endif
