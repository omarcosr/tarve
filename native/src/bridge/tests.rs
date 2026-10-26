use super::Events;
use std::{
    fs::OpenOptions,
    io::Read,
    os::windows::io::AsRawHandle,
    sync::Arc,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::Pipes::PeekNamedPipe;

fn available_bytes(file: &std::fs::File) -> u32 {
    let mut available = 0u32;
    let ok = unsafe {
        PeekNamedPipe(
            file.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    assert_ne!(ok, 0);
    available
}

#[test]
fn named_pipe_wakes_once_per_empty_to_nonempty_queue_transition() {
    let events = Events::new().expect("wake pipe");
    let name = events.wake_pipe_name();
    let mut client = OpenOptions::new()
        .read(true)
        .write(true)
        .open(name)
        .expect("connect wake pipe client");

    events.push(serde_json::json!({"type":"first"}));
    let mut byte = [0u8; 1];
    client.read_exact(&mut byte).expect("read first wake");
    assert_eq!(byte, [1]);

    events.push(serde_json::json!({"type":"second"}));
    assert_eq!(
        available_bytes(&client),
        0,
        "queued bursts must coalesce wake signals"
    );

    events
        .queue
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clear();
    events.push(serde_json::json!({"type":"third"}));
    client.read_exact(&mut byte).expect("read rearmed wake");
    assert_eq!(byte, [1]);
}

#[test]
fn named_pipe_survives_wake_backpressure() {
    let events = Events::new().expect("wake pipe");
    let name = events.wake_pipe_name();
    let client = OpenOptions::new()
        .read(true)
        .write(true)
        .open(name)
        .expect("connect wake pipe client");

    // The pipe is only a wake hint. Simulate a consumer that drains the FIFO faster than it
    // reads the wake bytes, causing many empty->nonempty transitions to accumulate in the
    // tiny pipe buffer. Backpressure must not destroy the transport.
    for index in 0..512 {
        events.push(serde_json::json!({"type":"burst", "index": index}));
        events
            .queue
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    assert!(
        available_bytes(&client) > 0,
        "at least one wake must remain readable"
    );
    events.push(serde_json::json!({"type":"after-backpressure"}));
    assert!(
        available_bytes(&client) > 0,
        "wake pipe must remain connected after backpressure"
    );
}

#[test]
fn named_pipe_large_fifo_has_no_lost_wake() {
    const TOTAL: usize = 50_000;
    let events = Arc::new(Events::new().expect("wake pipe"));
    let name = events.wake_pipe_name();
    let mut client = OpenOptions::new()
        .read(true)
        .write(true)
        .open(name)
        .expect("connect wake pipe client");
    let producer_events = events.clone();
    let producer = std::thread::spawn(move || {
        for index in 0..TOTAL {
            producer_events.push(serde_json::json!({"type":"stress", "index":index}));
        }
    });

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut drained = 0usize;
    let mut byte = [0u8; 1];
    while drained < TOTAL && Instant::now() < deadline {
        if available_bytes(&client) == 0 {
            std::thread::yield_now();
            continue;
        }
        client.read_exact(&mut byte).expect("read wake");
        assert_eq!(byte, [1]);
        let mut queue = events.queue.lock().unwrap_or_else(|p| p.into_inner());
        drained += queue.len();
        queue.clear();
    }
    producer.join().expect("producer");
    if drained < TOTAL {
        let mut queue = events.queue.lock().unwrap_or_else(|p| p.into_inner());
        drained += queue.len();
        queue.clear();
    }
    assert_eq!(drained, TOTAL, "every queued event must remain drainable");
}
