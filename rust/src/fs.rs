use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde_json::{json, Value};

const MAX_DIRS: usize = 400;

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

fn is_repo(path: &Path) -> bool {
    match fs::symlink_metadata(path.join(".git")) {
        Ok(m) => m.is_dir() || m.is_file(),
        Err(_) => false,
    }
}

fn list_roots() -> Vec<Value> {
    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            if is_dir(Path::new(&path)) {
                roots.push(json!({ "name": format!("{}:", letter as char), "path": path }));
            }
        }
        roots
    }
    #[cfg(not(windows))]
    {
        vec![json!({ "name": "/", "path": "/" })]
    }
}

/// 本机目录浏览：只返回目录名和是否为 git 仓库，不读取文件内容。
pub fn browse_dir(input: Option<String>) -> Result<Value> {
    let raw = input.unwrap_or_default();
    let raw = raw.trim();
    let mut target = if raw.is_empty() {
        home_dir()
    } else {
        PathBuf::from(raw)
    };
    if target.is_relative() {
        target = std::env::current_dir()?.join(target);
    }
    let target = std::path::absolute(&target)?;
    if !is_dir(&target) {
        bail!("目录不存在或不可访问：{}", target.display());
    }

    let mut dirs: Vec<Value> = Vec::new();
    let entries = fs::read_dir(&target)?;
    for entry in entries.flatten() {
        if dirs.len() >= MAX_DIRS {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "$RECYCLE.BIN" || name == "System Volume Information" || name == ".git" {
            continue;
        }
        let path = entry.path();
        let mut directory = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !directory {
            directory = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        }
        if !directory {
            continue;
        }
        dirs.push(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "repo": is_repo(&path),
        }));
    }
    dirs.sort_by(|a, b| {
        let ar = a.get("repo").and_then(Value::as_bool).unwrap_or(false);
        let br = b.get("repo").and_then(Value::as_bool).unwrap_or(false);
        br.cmp(&ar).then_with(|| {
            let an = a
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let bn = b
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            an.cmp(&bn)
        })
    });
    let truncated = dirs.len() >= MAX_DIRS;
    let parent = target.parent().map(|p| p.to_string_lossy().to_string());
    let root = target
        .ancestors()
        .last()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| target.to_string_lossy().to_string());

    Ok(json!({
        "path": target.to_string_lossy(),
        "parent": parent,
        "root": root,
        "home": home_dir().to_string_lossy(),
        "roots": list_roots(),
        "isRepo": is_repo(&target),
        "dirs": dirs,
        "truncated": truncated,
    }))
}
