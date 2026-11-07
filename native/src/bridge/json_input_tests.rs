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

#[test]
fn packed_node_updates_parse_as_their_json_does() {
    use crate::protocol::Command;
    let mut packed = vec![1_u8];
    let string = |out: &mut Vec<u8>, text: &str| {
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(text.as_bytes());
    };
    // Node "a": a colour, a whole number and a JSON value; node "é": its text.
    packed.push(1);
    string(&mut packed, "a");
    string(&mut packed, "background");
    string(&mut packed, "#ff0000");
    packed.push(2);
    string(&mut packed, "a");
    string(&mut packed, "opacity");
    packed.extend_from_slice(&1.0_f64.to_le_bytes());
    packed.push(3);
    string(&mut packed, "a");
    string(&mut packed, "shadow");
    string(&mut packed, r#"{"blur":2.5}"#);
    packed.push(4);
    string(&mut packed, "é");
    string(&mut packed, "Clicks: 2");
    let json = r##"{"type":"setNodes","nodes":[{"id":"a","style":{"background":"#ff0000","opacity":1,"shadow":{"blur":2.5}}},{"id":"é","text":"Clicks: 2"}]}"##;
    assert_eq!(
        format!("{:?}", Command::from_packed_sets(&packed).unwrap()),
        format!("{:?}", Command::from_json(json.as_bytes()).unwrap())
    );
    // Truncated or unknown records are errors, not a partial update.
    assert!(Command::from_packed_sets(&packed[..packed.len() - 3]).is_err());
    assert!(Command::from_packed_sets(&[1, 9, 0, 0, 0, 0]).is_err());
}
