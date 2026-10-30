use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{bail, Context};

use devhub::engine::Engine;
use devhub::store::Store;

#[derive(Debug, Default, PartialEq)]
struct Options {
    port: Option<u16>,
    data: Option<PathBuf>,
}

fn print_help() {
    println!(
        r#"DevHub (Rust) {}

用法：devhub.exe [选项]

选项：
  --port, -p <端口>   监听端口（默认 7373；被占用时自动尝试 7374-7399）
  --data, -d <目录>   数据目录（默认当前目录下的 .data，或 DEVHUB_DATA）
  --help, -h          显示帮助
  --version, -V       显示版本

环境变量：PORT、DEVHUB_DATA（命令行参数优先）

示例：
  devhub.exe --port 7374
  devhub.exe --port 7374 --data D:\devhub-data
"#,
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_port(value: &str) -> anyhow::Result<u16> {
    value
        .trim()
        .parse::<u16>()
        .with_context(|| format!("端口不是 0-65535 的数字：{}", value))
}

fn parse_args<I: Iterator<Item = String>>(mut args: I) -> anyhow::Result<Options> {
    let mut opts = Options::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" | "-p" => {
                let value = args.next().context("--port 需要一个端口号")?;
                opts.port = Some(parse_port(&value)?);
            }
            "--data" | "-d" => {
                let value = args.next().context("--data 需要一个目录")?;
                if value.trim().is_empty() {
                    bail!("--data 目录不能为空");
                }
                opts.data = Some(PathBuf::from(value));
            }
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--version" | "-V" => {
                println!("devhub {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            other if other.starts_with("--port=") => {
                opts.port = Some(parse_port(&other["--port=".len()..])?);
            }
            other if other.starts_with("--data=") => {
                let value = &other["--data=".len()..];
                if value.trim().is_empty() {
                    bail!("--data 目录不能为空");
                }
                opts.data = Some(PathBuf::from(value));
            }
            other => bail!("未知参数：{}（用 --help 查看用法）", other),
        }
    }
    Ok(opts)
}

fn env_port() -> anyhow::Result<Option<u16>> {
    match std::env::var("PORT") {
        Ok(value) if !value.trim().is_empty() => Ok(Some(parse_port(&value)?)),
        _ => Ok(None),
    }
}

async fn bind_listener(requested: Option<u16>) -> anyhow::Result<(tokio::net::TcpListener, u16)> {
    if let Some(port) = requested {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .with_context(|| format!("端口 {} 被占用或无法监听；请用 --port 换一个", port))?;
        let actual = listener.local_addr()?.port();
        return Ok((listener, actual));
    }

    // 没有显式指定端口：优先 7373，被占用就顺延。避免用户还要先查端口。
    for port in 7373..=7399u16 {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
            return Ok((listener, port));
        }
    }
    bail!("7373-7399 都被占用，请用 --port 指定其他端口")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let opts = parse_args(std::env::args().skip(1))?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "devhub=info".into()),
        )
        .init();

    let data = opts
        .data
        .or_else(|| std::env::var_os("DEVHUB_DATA").map(PathBuf::from))
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".data")
        });
    let data = std::path::absolute(&data).context("解析数据目录失败")?;
    let store = Store::open(data.clone()).context("打开数据目录失败")?;
    let engine = Engine::new(store);
    let app = devhub::api::router(engine);

    let requested = opts.port.or(env_port()?);
    let (listener, port) = bind_listener(requested).await?;

    println!();
    println!("  DevHub (Rust) 已启动");
    println!("  http://127.0.0.1:{}", port);
    if requested.is_none() && port != 7373 {
        println!("  7373 已被占用，已自动改用 {}", port);
    }
    println!();
    println!("  数据目录: {}", data.display());
    println!("  停止：Ctrl+C");
    println!();

    axum::serve(listener, app).await.context("HTTP 服务异常")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> impl Iterator<Item = String> {
        values
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn defaults_to_no_explicit_port() {
        assert_eq!(parse_args(args(&[])).unwrap(), Options::default());
    }

    #[test]
    fn parses_port_in_both_forms() {
        assert_eq!(
            parse_args(args(&["--port", "7374"])).unwrap().port,
            Some(7374)
        );
        assert_eq!(parse_args(args(&["-p", "7375"])).unwrap().port, Some(7375));
        assert_eq!(parse_args(args(&["--port=7376"])).unwrap().port, Some(7376));
    }

    #[test]
    fn parses_data_dir() {
        let opts = parse_args(args(&["--data", "D:\\devhub-data"])).unwrap();
        assert_eq!(opts.data, Some(PathBuf::from("D:\\devhub-data")));
        let opts = parse_args(args(&["--data=D:\\devhub-data2"])).unwrap();
        assert_eq!(opts.data, Some(PathBuf::from("D:\\devhub-data2")));
    }

    #[test]
    fn rejects_invalid_port_and_unknown_arg() {
        assert!(parse_args(args(&["--port", "not-a-port"])).is_err());
        assert!(parse_args(args(&["--nope"])).is_err());
    }
}
