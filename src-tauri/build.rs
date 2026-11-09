use std::path::Path;
use std::process::Command;

fn main() {
    // The target's OS, not the host's: `cfg!` here would describe the machine
    // running this script.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        link_clang_runtime();
    }
    tauri_build::build()
}

/// whisper.cpp guards its macOS 15 Metal calls with `@available`. Built for
/// `minimumSystemVersion`, which is older, that is a runtime check calling
/// `__isPlatformVersionAtLeast` from clang's runtime library -- and rustc links
/// with `-nodefaultlibs`, so that library is left out unless named here.
///
/// A link argument rather than `rustc-link-lib`, which would also have to find
/// its way through this package's library target. Only what is undefined gets
/// pulled from the archive.
fn link_clang_runtime() {
    let out = Command::new("cc")
        .arg("--print-runtime-dir")
        .output()
        .expect("could not run cc to find clang's runtime library");
    let dir = String::from_utf8_lossy(&out.stdout);
    let lib = Path::new(dir.trim()).join("libclang_rt.osx.a");
    assert!(lib.is_file(), "no clang runtime library at {}", lib.display());
    println!("cargo:rustc-link-arg={}", lib.display());
}
