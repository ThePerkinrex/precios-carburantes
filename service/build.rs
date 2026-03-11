fn main() {
    let mut features = Vec::new();

    for (key, _) in std::env::vars() {
        if let Some(name) = key.strip_prefix("CARGO_FEATURE_") {
            features.push(name.to_lowercase());
        }
    }

    println!("cargo:rustc-env=BUILD_FEATURES={}", features.join(","));
}