use super::should_force_x11_on_wsl;

#[test]
fn forces_x11_only_for_wsl_with_a_display() {
    assert!(should_force_x11_on_wsl(
        "6.18.33.2-microsoft-standard-WSL2",
        Some(":0")
    ));
    assert!(should_force_x11_on_wsl(
        "5.15.167.4-MICROSOFT-standard-WSL2",
        Some(":0")
    ));
    assert!(!should_force_x11_on_wsl("6.18.0-generic", Some(":0")));
    assert!(!should_force_x11_on_wsl(
        "6.18.33.2-microsoft-standard-WSL2",
        None
    ));
    assert!(!should_force_x11_on_wsl(
        "6.18.33.2-microsoft-standard-WSL2",
        Some("")
    ));
}
