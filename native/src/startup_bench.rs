//! Startup layout profile of a document: parse, tree build and first layout.
//! TARVE_DOC=<document.json> TARVE_TRACE=1 cargo test --release --lib startup_profile -- --ignored --nocapture

#[test]
#[ignore]
fn startup_profile() {
    let Some(path) = std::env::var_os("TARVE_DOC") else { return };
    let data = std::fs::read(path).unwrap();
    let t = std::time::Instant::now();
    let doc: crate::protocol::Document = serde_json::from_slice(&data).unwrap();
    let parsed = t.elapsed();
    let mut tree = crate::tree::Tree::new(doc.root);
    let built = t.elapsed();
    tree.compute(1024.0, 760.0).unwrap();
    let laid = t.elapsed();
    eprintln!("parse {:?} tree {:?} layout {:?}", parsed, built - parsed, laid - built);
    for _ in 0..3 {
        let doc: crate::protocol::Document = serde_json::from_slice(&data).unwrap();
        let t = std::time::Instant::now();
        let mut tree = crate::tree::Tree::new(doc.root);
        let built = t.elapsed();
        tree.compute(1024.0, 760.0).unwrap();
        eprintln!("again tree {:?} layout {:?}", built, t.elapsed() - built);
    }
}
