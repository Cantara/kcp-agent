//! Replay — re-fetch a manifest, re-plan from the echoed inputs, and detect
//! identical vs drifted. Builds a real plan artifact, serves the manifest over
//! loopback HTTP, and cross-examines it.
#![cfg(feature = "network")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kcp_planner::{parse_manifest, plan, plan_to_json, replay_artifact, verify_manifest_text, FetchGuard, PlanOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type Routes = Arc<Mutex<HashMap<String, String>>>;

async fn serve(listener: TcpListener, routes: Routes) {
    loop {
        let (mut sock, _) = match listener.accept().await {
            Ok(v) => v,
            Err(_) => return,
        };
        let routes = routes.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let body = routes.lock().unwrap().get(&path).cloned();
            let (status, body) = match body {
                Some(b) => ("200 OK", b),
                None => ("404 Not Found", String::new()),
            };
            let resp = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}

const M1: &str = "project: rep\nversion: 1.0.0\nkcp_version: \"0.25\"\nunits:\n  - id: u1\n    path: u1.md\n    intent: onboarding guide\n";
const M2: &str = "project: rep\nversion: 1.0.0\nkcp_version: \"0.25\"\nunits:\n  - id: u1\n    path: u1.md\n    intent: onboarding guide REVISED\n";

fn artifact_for(url: &str, yaml: &str) -> serde_json::Value {
    let manifest = parse_manifest(yaml, Some(url)).unwrap();
    let options = PlanOptions { as_of: Some("2026-07-07".into()), ..Default::default() };
    let p = plan(&manifest, "onboarding", &options);
    let sha = format!("{:x}", sha2::Sha256::digest(yaml.as_bytes()));
    let sig = verify_manifest_text(yaml, manifest.signing.as_ref(), Some(url));
    plan_to_json(&p, &manifest, &options, url, &sha, &sig)
}

use sha2::Digest;

#[tokio::test]
async fn identical_manifest_replays_identical() {
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{}/m", port);
    routes.lock().unwrap().insert("/m".to_string(), M1.to_string());
    tokio::spawn(serve(listener, routes.clone()));

    let artifact = artifact_for(&url, M1);
    let guard = FetchGuard { allow_private: true, ..Default::default() };
    let report = replay_artifact(&artifact, "test", &guard).await;

    assert_eq!(report.checks.len(), 1, "report: {:?}", report.checks);
    assert_eq!(report.checks[0].status, "identical", "detail: {}", report.checks[0].detail);
    assert!(report.ok);
}

#[tokio::test]
async fn changed_bytes_replay_drifted() {
    let routes: Routes = Arc::new(Mutex::new(HashMap::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{}/m", port);
    routes.lock().unwrap().insert("/m".to_string(), M1.to_string());
    tokio::spawn(serve(listener, routes.clone()));

    // Artifact pins M1's bytes; the server now returns M2 → sha drift.
    let artifact = artifact_for(&url, M1);
    routes.lock().unwrap().insert("/m".to_string(), M2.to_string());

    let guard = FetchGuard { allow_private: true, ..Default::default() };
    let report = replay_artifact(&artifact, "test", &guard).await;

    assert_eq!(report.checks[0].status, "drifted");
    assert!(report.checks[0].detail.contains("manifest bytes changed"));
    assert!(!report.ok);
}
