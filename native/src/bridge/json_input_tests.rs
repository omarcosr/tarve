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

#[test]
fn updates_parse_the_same_on_the_fast_path_as_through_the_tagged_enum() {
    use crate::protocol::Command;
    let node = r##"{"id":"a","kind":"view","style":{"width":4,"background":"#fff"},"children":[],"text":"x"}"##;
    for json in [
        format!(r#"{{"type":"patch","nodes":[{node}]}}"#),
        format!(
            r#"{{"type":"mutate","mutations":[{{"type":"patch","node":{node}}},{{"type":"remove","id":"b"}}]}}"#
        ),
        format!(r#"{{"type":"update","root":{node}}}"#),
    ] {
        let fast = Command::from_json(json.as_bytes()).unwrap();
        let tagged: Command = serde_json::from_str(&json).unwrap();
        assert_eq!(format!("{fast:?}"), format!("{tagged:?}"));
    }
    // A malformed update is still an error, and other commands take the tagged enum.
    assert!(Command::from_json(br#"{"type":"patch","nodes":7}"#).is_err());
    assert!(matches!(
        Command::from_json(br#"{"type":"close"}"#).unwrap(),
        Command::Close
    ));
}
