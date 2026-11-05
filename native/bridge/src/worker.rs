use super::{DeviceSession, Request, Result, execute_session};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    id: String,
    request: Request,
}

pub(super) async fn run(udid: &str) -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut session = DeviceSession::new();
    let work = async {
        loop {
            let mut line = Vec::new();
            // Requests are bounded before allocation; input is one JSON line per operation.
            loop {
                let chunk = input.fill_buf().await?;
                if chunk.is_empty() { if line.is_empty() { return Ok(()); } return Err("truncated worker request".into()); }
                let end = chunk.iter().position(|b| *b == b'\n').map(|n| n + 1);
                let take = end.unwrap_or(chunk.len());
                if line.len() + take > 2 * 1024 * 1024 { return Err("worker request exceeds 2 MiB".into()); }
                line.extend_from_slice(&chunk[..take]); input.consume(take);
                if end.is_some() { break; }
            }
            let envelope: Envelope = serde_json::from_slice(&line)?;
            if envelope.id.is_empty() || envelope.id.len() > 80 { return Err("invalid request id".into()); }
            let started = std::time::Instant::now();
            let limit = if matches!(&envelope.request, Request::InstallApp { .. }) { 180 } else { 90 };
            let operation = async {
                envelope.request.validate()?;
                execute_session(udid, envelope.request, &mut session).await
            };
            let reply = tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(limit), operation) => match result {
                    Ok(Ok(value)) => json!({"id":envelope.id,"result":value,"elapsed_ms":started.elapsed().as_millis()}),
                    Ok(Err(error)) => { session.close().await; json!({"id":envelope.id,"error":error.to_string()}) },
                    Err(_) => { session.close().await; json!({"id":envelope.id,"error":"Native operation timed out; dispatched action outcome is unknown"}) }
                },
                _ = tokio::signal::ctrl_c() => return Ok(()),
                _ = terminated() => return Ok(()),
            };
            output.write_all(format!("{reply}\n").as_bytes()).await?;
            output.flush().await?;
        }
    };
    let result = tokio::select! {
        result = work => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = terminated() => Ok(()),
    };
    session.close().await;
    result
}
#[cfg(unix)]
async fn terminated() {
    if let Ok(mut signal) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        signal.recv().await;
    }
}
#[cfg(not(unix))]
async fn terminated() {
    std::future::pending::<()>().await;
}
