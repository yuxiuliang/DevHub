use anyhow::{bail, Context, Result};
use tokio::process::Command;

async fn git_cmd(repo: &str, args: &[&str]) -> Result<(String, String)> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.as_std_mut().creation_flags(0x08000000);
    }
    let out = cmd.output().await.context("启动 git 失败")?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        bail!("{}", if stderr.is_empty() { stdout } else { stderr });
    }
    Ok((stdout, stderr))
}

pub async fn git(repo: &str, args: &[&str]) -> Result<(String, String)> {
    git_cmd(repo, args).await
}

pub async fn is_repo(path: &str) -> bool {
    matches!(git(path, &["rev-parse", "--is-inside-work-tree"]).await, Ok((stdout, _)) if stdout == "true")
}

pub async fn current_branch(repo: &str) -> String {
    match git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
        Ok((stdout, _)) if !stdout.is_empty() && stdout != "HEAD" => stdout,
        _ => "main".to_string(),
    }
}

pub async fn rev_parse(repo: &str, reference: &str) -> Result<String> {
    Ok(git(repo, &["rev-parse", reference]).await?.0)
}

pub async fn add_worktree(repo: &str, path: &str, branch: &str, base: &str) -> Result<()> {
    let _ = git(repo, &["worktree", "remove", "--force", path]).await;
    let _ = git(repo, &["worktree", "prune"]).await;
    git(repo, &["worktree", "add", "-B", branch, path, base]).await?;
    Ok(())
}

pub async fn status_porcelain(path: &str) -> String {
    git(path, &["status", "--porcelain"])
        .await
        .map(|x| x.0)
        .unwrap_or_default()
}

pub async fn tracked_status(path: &str) -> String {
    git(path, &["status", "--porcelain", "--untracked-files=no"])
        .await
        .map(|x| x.0)
        .unwrap_or_default()
}

pub async fn commit_all(path: &str, message: &str) -> Result<bool> {
    if status_porcelain(path).await.is_empty() {
        return Ok(false);
    }
    git(path, &["add", "-A"]).await?;
    git(
        path,
        &[
            "-c",
            "user.name=DevHub",
            "-c",
            "user.email=devhub@local",
            "commit",
            "-m",
            message,
            "--no-verify",
        ],
    )
    .await?;
    Ok(true)
}

pub async fn diff(path: &str, base_sha: &str) -> String {
    if let Ok((stdout, _)) = git(path, &["diff", "--no-color", base_sha, "HEAD"]).await {
        if !stdout.is_empty() {
            return stdout;
        }
    }
    git(path, &["diff", "--no-color", base_sha])
        .await
        .map(|x| x.0)
        .unwrap_or_default()
}

pub async fn diff_stat(path: &str, base_sha: &str) -> String {
    git(path, &["diff", "--stat", base_sha, "HEAD"])
        .await
        .map(|x| x.0)
        .unwrap_or_default()
}

pub async fn commit_sha(repo: &str, reference: &str) -> Result<String> {
    let sha = git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{}^{{commit}}", reference),
        ],
    )
    .await?
    .0;
    if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("Git 没有返回有效提交，请检查任务分支后重试");
    }
    Ok(sha.to_ascii_lowercase())
}

pub async fn diff_commit(repo: &str, base_sha: &str, result_sha: &str) -> Result<String> {
    // Resolve both references to commits before passing them as diff arguments.
    let base = commit_sha(repo, base_sha).await?;
    let result = commit_sha(repo, result_sha).await?;
    Ok(git(
        repo,
        &["diff", "--no-color", "--no-ext-diff", &base, &result, "--"],
    )
    .await?
    .0)
}

pub async fn tracked_status_checked(path: &str) -> Result<String> {
    Ok(
        git(path, &["status", "--porcelain", "--untracked-files=no"])
            .await?
            .0,
    )
}

pub async fn merge_squash(
    repo: &str,
    base_branch: &str,
    branch: &str,
    message: &str,
) -> Result<()> {
    let dirty = git(repo, &["status", "--porcelain"]).await?.0;
    if !dirty.is_empty() {
        let files = dirty.lines().take(5).collect::<Vec<_>>().join("；");
        bail!("仓库有未提交的改动，请先处理后再合并：{}", files);
    }
    git(repo, &["checkout", base_branch]).await?;
    if let Err(e) = git(repo, &["merge", "--squash", branch]).await {
        let _ = git(repo, &["reset", "--merge"]).await;
        bail!("合并冲突：{}", e.to_string().lines().next().unwrap_or(""));
    }
    let commit_result: Result<()> = async {
        // A previous merge may have committed before its task status was saved.
        let staged_tree = git(repo, &["write-tree"]).await?.0;
        let head_tree = git(repo, &["rev-parse", "--verify", "HEAD^{tree}"]).await?.0;
        if staged_tree == head_tree {
            git(repo, &["reset", "--merge"]).await?;
            return Ok(());
        }
        git(
            repo,
            &[
                "-c",
                "user.name=DevHub",
                "-c",
                "user.email=devhub@local",
                "commit",
                "-m",
                message,
                "--no-verify",
            ],
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(e) = commit_result {
        let _ = git(repo, &["reset", "--merge"]).await;
        bail!(
            "合并提交失败：{}",
            e.to_string().lines().next().unwrap_or("")
        );
    }
    Ok(())
}
