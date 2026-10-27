use super::{MAX_JSON_INPUT_BYTES, read_json};

#[test]
fn input_limit_can_transport_one_maximum_dynamic_image() {
    const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
    let base64_bytes = MAX_IMAGE_BYTES.div_ceil(3) * 4;
    assert!(
        u64::from(MAX_JSON_INPUT_BYTES) > base64_bytes + 1024,
        "JSON input cap must fit a maximum image after base64 expansion"
    );
}

#[test]
fn read_json_rejects_oversized_input_before_dereferencing_the_buffer() {
    let byte = b'0';
    let result = unsafe {
        read_json::<serde_json::Value>(std::ptr::from_ref(&byte), MAX_JSON_INPUT_BYTES + 1)
    };
    assert_eq!(result.unwrap_err(), "Invalid input buffer");
}
