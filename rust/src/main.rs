use std::path::PathBuf;

use anyhow::Context;

use devhub::engine::Engine;
use devhub::store::Store;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "devhub=info".into()),
        )
        .init();

    let data = std::env::var_os("DEVHUB_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(".data")
        });
    let data = std::path::absolute(&data).context("解析数据目录失败")?;
    let store = Store::open(data.clone()).context("打开数据目录失败")?;
    let engine = Engine::new(store);
    let app = devhub::api::router(engine);

    let port = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(7373);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("端口 {} 被占用或无法监听", port))?;

    println!();
    println!("  DevHub (Rust) 已启动");
    println!("  http://127.0.0.1:{}", port);
    println!();
    println!("  数据目录: {}", data.display());
    println!("  Ctrl+C 停止");
    println!();

    axum::serve(listener, app).await.context("HTTP 服务异常")?;
    Ok(())
}
