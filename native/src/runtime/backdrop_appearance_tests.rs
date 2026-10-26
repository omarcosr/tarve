use super::hex_luminance;

#[test]
fn window_background_lightness_picks_the_material_appearance() {
    assert!(hex_luminance("#ffffff00").unwrap() > 0.99);
    assert!(hex_luminance("#18181b40").unwrap() < 0.5);
    assert!(hex_luminance("#fff").unwrap() > 0.99);
    assert_eq!(hex_luminance("#000000"), Some(0.0));
    assert_eq!(hex_luminance("transparent"), None);
    assert_eq!(hex_luminance("#12345"), None);
}
