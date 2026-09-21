#ifndef TARVE_H
#define TARVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* All pointers refer to caller-owned buffers valid only for the duration of a call.
   Never unload the DLL until tarve_join has returned and the event worker exited.
   Exactly one start per process (Winit's event loop lifecycle). */
uint32_t tarve_abi_version(void);
/* UTF-8 JSON document/command, explicit byte length, no NUL terminator. 0 = success. */
int32_t tarve_start(const uint8_t *json, uint32_t length);
int32_t tarve_send(const uint8_t *json, uint32_t length);
/* Blocking wait. Positive = bytes copied; < -1 = required capacity (event retained).
   -1 = error. One consumer, called only in the dedicated Bun worker. */
int32_t tarve_wait_event(uint8_t *buffer, uint32_t capacity);
int32_t tarve_last_error(uint8_t *buffer, uint32_t capacity);
/* Call after receiving closed. Joins the native window thread. */
int32_t tarve_join(void);
#ifdef __cplusplus
}
#endif
#endif
