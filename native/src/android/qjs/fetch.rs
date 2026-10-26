//! `fetch` for the JS app: each request runs on its own thread (ureq over rustls) and the
//! app loop settles it through `__tarveFetchDone` (packages/core/android/fetch.ts).

use super::exception;
use crate::android::{LOG_ERROR, log, notify_host};
use rquickjs::{Context, Function, TypedArray};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(feature = "net")]
use std::time::Duration;

struct Fetched {
    id: u32,
    outcome: Result<FetchResponse, String>,
}

struct FetchResponse {
    status: u16,
    status_text: String,
    headers: Vec<String>,
    body: Vec<u8>,
}

static FETCHED: Mutex<Vec<Fetched>> = Mutex::new(Vec::new());
pub(super) static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

pub(super) fn start_fetch(
    id: u32,
    method: String,
    url: String,
    headers: Vec<String>,
    body: Option<Vec<u8>>,
) {
    IN_FLIGHT.fetch_add(1, Ordering::AcqRel);
    let spawned = std::thread::Builder::new()
        .name("tarve-fetch".into())
        .spawn(move || {
            let outcome = fetch(&method, &url, &headers, body);
            FETCHED
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(Fetched { id, outcome });
            IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
            notify_host();
        });
    if let Err(error) = spawned {
        FETCHED
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(Fetched {
                id,
                outcome: Err(error.to_string()),
            });
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(feature = "net")]
fn fetch(
    method: &str,
    url: &str,
    headers: &[String],
    body: Option<Vec<u8>>,
) -> Result<FetchResponse, String> {
    use std::sync::OnceLock;
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(30)))
            .build()
            .into()
    });
    let mut request = ureq::http::Request::builder().method(method).uri(url);
    for [name, value] in headers.as_chunks::<2>().0 {
        request = request.header(name, value);
    }
    let request = request
        .body(body.unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let mut response = agent.run(request).map_err(|e| e.to_string())?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .flat_map(|(name, value)| {
            [
                name.as_str().to_owned(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            ]
        })
        .collect();
    let body = response
        .body_mut()
        .with_config()
        .limit(1 << 30)
        .read_to_vec()
        .map_err(|e| e.to_string())?;
    Ok(FetchResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        headers,
        body,
    })
}

#[cfg(not(feature = "net"))]
fn fetch(_: &str, _: &str, _: &[String], _: Option<Vec<u8>>) -> Result<FetchResponse, String> {
    Err("fetch needs the native `net` feature".into())
}

pub(super) fn deliver_fetches(context: &Context) {
    let done = std::mem::take(&mut *FETCHED.lock().unwrap_or_else(|p| p.into_inner()));
    if done.is_empty() {
        return;
    }
    context.with(|ctx| {
        let Ok(callback) = ctx.globals().get::<_, Function>("__tarveFetchDone") else {
            return;
        };
        for Fetched { id, outcome } in done {
            let result = match outcome {
                Ok(response) => {
                    TypedArray::<u8>::new(ctx.clone(), response.body).and_then(|body| {
                        callback.call::<_, ()>((
                            id,
                            response.status,
                            response.status_text,
                            response.headers,
                            body,
                            rquickjs::Undefined,
                        ))
                    })
                }
                Err(message) => callback.call::<_, ()>((
                    id,
                    0,
                    String::new(),
                    Vec::<String>::new(),
                    rquickjs::Undefined,
                    message,
                )),
            };
            if let Err(error) = result {
                log(LOG_ERROR, &exception(&ctx, error));
            }
        }
    });
}
