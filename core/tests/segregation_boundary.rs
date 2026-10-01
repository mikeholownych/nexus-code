use std::fs;
use std::process::Command;

/// Tests clean segregation boundary between Rust core and TypeScript CLI (SEGR-001..SEGR-003).
/// Verifies that:
/// 1. harness-core exposes an explicit, typed boundary via CLI and JSON-RPC.
/// 2. Failures at the boundary return structured errors without panicking.
/// 3. Resource confinement enforces strict workspace isolation at the core layer.
#[test]
#[cfg(unix)]
fn test_core_segregation_boundary_and_fault_isolation() {
    let root = std::env::temp_dir().join(format!("test_segregation_{}", std::process::id()));
    let workspace = root.join("workspace");
    let external = root.join("external");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&external).unwrap();

    let secret_file = external.join("outside.txt");
    fs::write(&secret_file, "SENSITIVE_HOST_DATA").unwrap();

    let safe_file = workspace.join("safe.txt");
    fs::write(&safe_file, "SAFE_WORKSPACE_DATA").unwrap();

    let exe = env!("CARGO_BIN_EXE_harness-core");

    // 1. Clean RPC invocation of read_file within workspace
    let output_safe = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("read_file")
        .arg("--args")
        .arg(r#"{"path":"safe.txt"}"#)
        .output()
        .expect("Failed to execute harness-core");

    assert!(output_safe.status.success(), "Safe read_file should succeed");
    let safe_stdout = String::from_utf8_lossy(&output_safe.stdout);
    assert!(
        safe_stdout.contains("SAFE_WORKSPACE_DATA"),
        "Safe file read output must contain workspace file content"
    );

    // 2. Out-of-bounds read_file attempt must fail safely without panicking (SEGR-003, RES-004)
    let output_denied = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("read_file")
        .arg("--args")
        .arg(r#"{"path":"../external/outside.txt"}"#)
        .output()
        .expect("Failed to execute harness-core");

    assert!(
        !output_denied.status.success(),
        "Traversal read_file must return non-zero exit status"
    );
    let denied_err = String::from_utf8_lossy(&output_denied.stderr);
    assert!(
        denied_err.contains("Security Violation") || denied_err.contains("escapes workspace jail"),
        "Traversal must be blocked with security violation error"
    );

    // 3. Malformed JSON arguments return structured error without panic (SEGR-001)
    let output_malformed = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("read_file")
        .arg("--args")
        .arg(r#"{"invalid_json": true"#) // truncated json
        .output()
        .expect("Failed to execute harness-core");

    assert!(
        !output_malformed.status.success(),
        "Malformed JSON must return non-zero exit code"
    );
    let malformed_err = String::from_utf8_lossy(&output_malformed.stderr);
    assert!(
        malformed_err.to_lowercase().contains("error") || malformed_err.contains("Could not parse JSON"),
        "Must report structured argument parse error without crash"
    );

    // 4. Unknown tool returns structured error without crashing (SEGR-001)
    let output_unknown = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("non_existent_tool_xyz")
        .arg("--args")
        .arg("{}")
        .output()
        .expect("Failed to execute harness-core");

    assert!(
        !output_unknown.status.success(),
        "Unknown tool must return non-zero exit code"
    );
    let unknown_err = String::from_utf8_lossy(&output_unknown.stderr);
    assert!(
        unknown_err.contains("Unknown tool"),
        "Must report unknown tool error"
    );

    let _ = fs::remove_dir_all(&root);
}
