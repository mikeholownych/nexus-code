use std::fs;
use std::process::Command;

#[test]
#[cfg(unix)]
fn test_cli_runner_cwd_escape_rejected() {
    let root = std::env::temp_dir().join(format!("test_cli_runner_{}", std::process::id()));
    let workspace = root.join("workspace");
    let external = root.join("external");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&external).unwrap();

    let exe = env!("CARGO_BIN_EXE_harness-core");

    // Attempt 1: cwd: /etc
    let output1 = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("run_command")
        .arg("--args")
        .arg(r#"{"command":"pwd","cwd":"/etc"}"#)
        .output()
        .expect("Failed to execute harness-core");

    let stdout1 = String::from_utf8_lossy(&output1.stdout);
    let stderr1 = String::from_utf8_lossy(&output1.stderr);
    let combined1 = format!("{stdout1}\n{stderr1}");
    assert!(
        combined1.contains("Security Violation: cwd escapes workspace jail"),
        "Expected cwd /etc to be rejected, got: {combined1}"
    );

    // Attempt 2: cwd: ../../
    let output2 = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("run_command")
        .arg("--args")
        .arg(r#"{"command":"pwd","cwd":"../../"}"#)
        .output()
        .expect("Failed to execute harness-core");

    let stdout2 = String::from_utf8_lossy(&output2.stdout);
    let stderr2 = String::from_utf8_lossy(&output2.stderr);
    let combined2 = format!("{stdout2}\n{stderr2}");
    assert!(
        combined2.contains("Security Violation: cwd escapes workspace jail"),
        "Expected cwd ../../ to be rejected, got: {combined2}"
    );

    // Attempt 3: Symlink cwd escaping workspace
    let sym_cwd = workspace.join("sym_ext");
    let _ = std::os::unix::fs::symlink(&external, &sym_cwd);

    let output3 = Command::new(exe)
        .arg("--workspace")
        .arg(&workspace)
        .arg("call")
        .arg("--tool")
        .arg("run_command")
        .arg("--args")
        .arg(r#"{"command":"pwd","cwd":"sym_ext"}"#)
        .output()
        .expect("Failed to execute harness-core");

    let stdout3 = String::from_utf8_lossy(&output3.stdout);
    let stderr3 = String::from_utf8_lossy(&output3.stderr);
    let combined3 = format!("{stdout3}\n{stderr3}");
    assert!(
        combined3.contains("Security Violation: cwd escapes workspace jail"),
        "Expected symlink cwd to be rejected, got: {combined3}"
    );

    let _ = fs::remove_dir_all(&root);
}
