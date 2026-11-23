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
    run(&repo, &["config", "core.autocrlf", "false"]);
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

fn make_feature(repo: &str) -> (String, String) {
    let repo = Path::new(repo);
    let base = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
    run(repo, &["checkout", "-b", "feature"]);
    std::fs::write(repo.join("feature.txt"), "feature\n").unwrap();
    run(repo, &["add", "-A"]);
    run(repo, &[
        "-c", "user.name=DevHub", "-c", "user.email=devhub@local",
        "commit", "-m", "feature work", "--no-verify",
    ]);
    let result = run(repo, &["rev-parse", "HEAD"]);
    run(repo, &["checkout", &base]);
    (base, result)
}

#[tokio::test]
async fn repeated_squash_preserves_later_base_commits_and_clears_squash_state() {
    let (_dir, repo) = make_repo();
    let (base, result) = make_feature(&repo);
    let path = Path::new(&repo);
    git::merge_squash(&repo, &base, &result, "merge feature").await.unwrap();
    std::fs::write(path.join("later.txt"), "later base work\n").unwrap();
    run(path, &["add", "-A"]);
    run(path, &[
        "-c", "user.name=DevHub", "-c", "user.email=devhub@local",
        "commit", "-m", "later base work", "--no-verify",
    ]);
    let head = run(path, &["rev-parse", "HEAD"]);
    // An already-applied result must not attempt another commit or require signing.
    run(path, &["config", "commit.gpgsign", "true"]);
    run(path, &["config", "gpg.program", &path.join("missing-gpg").to_string_lossy()]);
    for _ in 0..2 {
        git::merge_squash(&repo, &base, &result, "retry feature").await.unwrap();
        assert_eq!(run(path, &["rev-parse", "HEAD"]), head);
        assert_eq!(run(path, &["rev-list", "--count", "HEAD"]), "3");
        assert_eq!(run(path, &["status", "--porcelain"]), "");
        assert_eq!(std::fs::read_to_string(path.join("later.txt")).unwrap(), "later base work\n");
        assert_eq!(std::fs::read_to_string(path.join("feature.txt")).unwrap(), "feature\n");
        let squash_message = run(path, &["rev-parse", "--git-path", "SQUASH_MSG"]);
        assert!(!path.join(squash_message).exists());
    }
}

#[tokio::test]
async fn squash_still_rejects_dirty_repositories_conflicts_and_commit_failures() {
    for failure in ["dirty", "conflict", "commit"] {
        let (_dir, repo) = make_repo();
        let (base, result) = make_feature(&repo);
        let path = Path::new(&repo);
        let expected_error = match failure {
            "dirty" => {
                std::fs::write(path.join("local.txt"), "keep my work\n").unwrap();
                "未提交"
            }
            "conflict" => {
                std::fs::write(path.join("feature.txt"), "different base change\n").unwrap();
                run(path, &["add", "-A"]);
                run(path, &[
                    "-c", "user.name=DevHub", "-c", "user.email=devhub@local",
                    "commit", "-m", "conflicting base work", "--no-verify",
                ]);
                "合并冲突"
            }
            "commit" => {
                run(path, &["config", "commit.gpgsign", "true"]);
                run(path, &["config", "gpg.program", &path.join("missing-gpg").to_string_lossy()]);
                "合并提交失败"
            }
            _ => unreachable!(),
        };
        let head = run(path, &["rev-parse", "HEAD"]);
        let error = git::merge_squash(&repo, &base, &result, "merge feature").await.unwrap_err();
        assert!(error.to_string().contains(expected_error), "{failure}: {error}");
        assert_eq!(run(path, &["rev-parse", "HEAD"]), head, "{failure}");
        if failure == "dirty" {
            assert_eq!(std::fs::read_to_string(path.join("local.txt")).unwrap(), "keep my work\n");
        } else {
            assert_eq!(run(path, &["status", "--porcelain"]), "", "{failure}");
        }
        let squash_message = run(path, &["rev-parse", "--git-path", "SQUASH_MSG"]);
        assert!(!path.join(squash_message).exists(), "{failure}");
    }
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
