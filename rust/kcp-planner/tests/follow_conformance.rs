//! Federation walk — plan_tree fetches a hub and its eligible leaf over a real
//! (loopback) HTTP server, verifies against the guard, and honors the depth cap.
//! Exercises the whole network path end-to-end: guarded fetch, remote-capable
//! verify (unsigned here), and the recursive tree build.
#![cfg(feature = "network")]

use std::collections::HashMap;

use kcp_planner::{plan_tree, FetchGuard, FollowOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A throwaway HTTP/1.1 server that returns a fixed body per path. One request
/// per connection (Connection: close), which is all the walk makes.
async fn serve(listener: TcpListener, routes: HashMap<String, String>) {
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
            let (status, body) = match routes.get(&path) {
                Some(b) => ("200 OK", b.clone()),
                None => ("404 Not Found", String::new()),
            };
            let resp = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            let _ = sock.write_all(resp.as_bytes()).await;
        });
    }
}

fn hub(port: u16) -> String {
    format!(
        "project: hub\nversion: 1.0.0\nkcp_version: \"0.25\"\nunits:\n  - id: hub-unit\n    path: h.md\n    intent: hub root doc\nmanifests:\n  - id: leaf\n    url: http://127.0.0.1:{}/leaf\n",
        port
    )
}
const LEAF: &str = "project: leaf\nversion: 1.0.0\nunits:\n  - id: leaf-unit\n    path: l.md\n    intent: leaf content doc\n";

fn guard() -> FetchGuard {
    FetchGuard { allow_private: true, ..Default::default() }
}

#[tokio::test]
async fn follows_the_eligible_leaf_over_http() {
    let mut routes = HashMap::new();
    let port = {
        // bind first to learn the port, then register routes that reference it
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        routes.insert("/hub".to_string(), hub(port));
        routes.insert("/leaf".to_string(), LEAF.to_string());
        tokio::spawn(serve(listener, routes.clone()));
        port
    };

    let opts = FollowOptions { max_depth: 1, fetch_guard: guard(), ..Default::default() };
    let root = plan_tree(&format!("http://127.0.0.1:{}/hub", port), "hub", &opts).await;

    assert!(root.error.is_none(), "root errored: {:?}", root.error);
    assert!(root.plan.is_some(), "root should have a plan");
    assert_eq!(root.plan.as_ref().unwrap().manifest_project, "hub");
    // unsigned manifest fetched over http → verified path reports unsigned, not invalid
    assert_eq!(root.signature.as_ref().unwrap().status, "unsigned");
    assert_eq!(root.children.len(), 1, "should have followed one leaf");
    let leaf = &root.children[0];
    assert_eq!(leaf.ref_id.as_deref(), Some("leaf"));
    assert_eq!(leaf.plan.as_ref().unwrap().manifest_project, "leaf");
    // sha256 is pinned from the exact fetched bytes
    assert!(leaf.sha256.as_ref().is_some_and(|s| s.len() == 64));
}

#[tokio::test]
async fn depth_zero_reports_the_leaf_not_followed() {
    let mut routes = HashMap::new();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    routes.insert("/hub".to_string(), hub(port));
    routes.insert("/leaf".to_string(), LEAF.to_string());
    tokio::spawn(serve(listener, routes));

    let opts = FollowOptions { max_depth: 0, fetch_guard: guard(), ..Default::default() };
    let root = plan_tree(&format!("http://127.0.0.1:{}/hub", port), "hub", &opts).await;

    assert!(root.children.is_empty(), "depth 0 must not follow");
    assert_eq!(root.not_followed.len(), 1);
    assert!(root.not_followed[0].reason.contains("beyond max depth 0"));
}

#[tokio::test]
async fn cleartext_http_is_refused_without_allow_private() {
    // The guard must refuse http:// (and the loopback address) by default.
    let opts = FollowOptions { max_depth: 1, ..Default::default() }; // guard default: allow_private = false
    let root = plan_tree("http://127.0.0.1:9/hub", "hub", &opts).await;
    assert!(root.error.is_some());
    let err = root.error.unwrap();
    assert!(err.contains("fetch failed") && (err.contains("private") || err.contains("cleartext")), "unexpected error: {}", err);
}
