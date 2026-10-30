use std::path::Path;
use std::process::Command;

use devhub::git;
use tempfile::tempdir;

fn run(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn make_repo() -> (tempfile::TempDir, String) {
    let dir = tempdir().unwrap();
    let repo = dir.path().to_path_buf();
    run(&repo, &["init"]);
    std::fs::write(repo.join("README.md"), "# test\n").unwrap();
    run(&repo, &["add", "-A"]);
    run(
        &repo,
        &[
            "-c",
            "user.name=DevHub",
            "-c",
            "user.email=devhub@local",
            "commit",
            "-m",
            "init",
        ],
    );
    let path = repo.to_string_lossy().to_string();
    (dir, path)
}

#[tokio::test]
async fn tracked_status_ignores_untracked_but_detects_tracked_changes() {
    let (_dir, repo) = make_repo();
    std::fs::write(Path::new(&repo).join("artifact.tmp"), "artifact\n").unwrap();
    assert!(git::status_porcelain(&repo).await.contains("artifact.tmp"));
    assert_eq!(git::tracked_status(&repo).await, "");

    std::fs::write(Path::new(&repo).join("README.md"), "# changed\n").unwrap();
    assert!(git::tracked_status(&repo).await.contains("README.md"));
}

#[tokio::test]
async fn merge_squash_creates_one_commit_and_keeps_base_history() {
    let (_dir, repo) = make_repo();
    let base = run(Path::new(&repo), &["rev-parse", "--abbrev-ref", "HEAD"]);
    run(Path::new(&repo), &["checkout", "-b", "feature"]);
    std::fs::write(Path::new(&repo).join("feature.txt"), "feature\n").unwrap();
    run(Path::new(&repo), &["add", "-A"]);
    run(
        Path::new(&repo),
        &[
            "-c",
            "user.name=DevHub",
            "-c",
            "user.email=devhub@local",
            "commit",
            "-m",
            "feature work",
        ],
    );
    run(Path::new(&repo), &["checkout", &base]);

    git::merge_squash(&repo, &base, "feature", "merge feature")
        .await
        .unwrap();

    let log = run(Path::new(&repo), &["log", "--oneline", &base]);
    assert!(log.contains("merge feature"));
    assert!(log.contains("init"));
    assert_eq!(git::status_porcelain(&repo).await, "");
}
