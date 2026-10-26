//! TARVE_GPU_REPORT=1 (Android: `adb shell setprop debug.tarve.gpumem 1`): the GPU allocations
//! by name after every frame, to see where the GPU renderer's memory goes.
use vello::wgpu;

pub(super) fn log(device: &wgpu::Device) {
    static REPORT: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*REPORT.get_or_init(|| std::env::var_os("TARVE_GPU_REPORT").is_some()) {
        return;
    }
    let Some(report) = device.generate_allocator_report() else {
        return;
    };
    let mut by: std::collections::BTreeMap<String, (u64, u32)> = Default::default();
    for allocation in &report.allocations {
        let entry = by.entry(allocation.name.clone()).or_default();
        entry.0 += allocation.size;
        entry.1 += 1;
    }
    eprintln!(
        "[gpumem] allocated={} MB reserved={} MB blocks={}",
        report.total_allocated_bytes >> 20,
        report.total_reserved_bytes >> 20,
        report.blocks.len()
    );
    for (name, (size, count)) in by.iter().filter(|(_, (size, _))| *size > 1 << 19) {
        eprintln!("[gpumem]   {name} x{count} {} KiB", size >> 10);
    }
}
