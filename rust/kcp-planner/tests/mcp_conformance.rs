//! MCP server — the JSON-RPC surface. Drives handle_message through initialize,
//! tools/list, and tools/call (kcp_validate, kcp_plan, kcp_trace) against a
//! loopback manifest, plus notification/unknown-method handling.
#![cfg(feature = "network")]

use std::collections::HashMap;

use kcp_planner::handle_message;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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

const MANIFEST: &str = "project: mcp-demo\nversion: 1.0.0\nkcp_version: \"0.25\"\nunits:\n  - id: onboarding\n    path: onboarding.md\n    intent: how to get started with the API\n    triggers: [getting started, onboarding]\n";

async fn start() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut routes = HashMap::new();
    routes.insert("/m".to_string(), MANIFEST.to_string());
    tokio::spawn(serve(listener, routes));
    format!("http://127.0.0.1:{}/m", port)
}

#[tokio::test]
async fn initialize_and_tools_list() {
    let init = handle_message(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} })).await.unwrap();
    assert_eq!(init["result"]["serverInfo"]["name"], "kcp-planner");
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");

    let list = handle_message(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await.unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["kcp_plan", "kcp_load", "kcp_validate", "kcp_trace", "kcp_replay"]);
}

#[tokio::test]
async fn tools_call_validate_and_plan_over_http() {
    let url = start().await;

    // kcp_validate → a report; the demo manifest is valid.
    let vresp = handle_message(&json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "kcp_validate", "arguments": { "manifest": url, "allow_private_hosts": true } }
    })).await.unwrap();
    assert_eq!(vresp["result"]["isError"], false);
    let vtext = vresp["result"]["content"][0]["text"].as_str().unwrap();
    let vreport: serde_json::Value = serde_json::from_str(vtext).unwrap();
    assert_eq!(vreport["project"], "mcp-demo");
    assert_eq!(vreport["ok"], true);

    // kcp_plan → a plan tree; onboarding should be selected for the matching task.
    let presp = handle_message(&json!({
        "jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": { "name": "kcp_plan", "arguments": { "manifest": url, "task": "getting started onboarding", "as_of": "2026-07-07", "allow_private_hosts": true } }
    })).await.unwrap();
    assert_eq!(presp["result"]["isError"], false);
    let ptext = presp["result"]["content"][0]["text"].as_str().unwrap();
    let tree: serde_json::Value = serde_json::from_str(ptext).unwrap();
    assert_eq!(tree["plan"]["manifest"]["project"], "mcp-demo");
    let selected = tree["plan"]["selected"].as_array().unwrap();
    assert!(selected.iter().any(|u| u["id"] == "onboarding"), "onboarding should be selected: {}", ptext);
    // unsigned manifest over http → the node's signature reports unsigned
    assert_eq!(tree["signature"]["status"], "unsigned");
}

#[tokio::test]
async fn tools_call_load_serves_unit_content() {
    // Serve the manifest and the unit it references.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut routes = HashMap::new();
    routes.insert("/m".to_string(), MANIFEST.to_string());
    routes.insert("/onboarding.md".to_string(), "# Onboarding\nRun `npm install`.".to_string());
    tokio::spawn(serve(listener, routes));
    let url = format!("http://127.0.0.1:{}/m", port);

    let resp = handle_message(&json!({
        "jsonrpc": "2.0", "id": 5, "method": "tools/call",
        "params": { "name": "kcp_load", "arguments": { "manifest": url, "task": "getting started onboarding", "as_of": "2026-07-07", "allow_private_hosts": true } }
    })).await.unwrap();
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    let out: serde_json::Value = serde_json::from_str(text).unwrap();
    let units = out["units"].as_array().unwrap();
    assert!(units.iter().any(|u| u["id"] == "onboarding" && u["content"].as_str().unwrap().contains("npm install")), "unit content should be served: {}", text);
}

#[tokio::test]
async fn notifications_and_unknown_methods() {
    // A notification (no id) is acknowledged silently.
    assert!(handle_message(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.is_none());
    // An unknown method with an id gets a JSON-RPC error.
    let err = handle_message(&json!({ "jsonrpc": "2.0", "id": 9, "method": "no/such" })).await.unwrap();
    assert_eq!(err["error"]["code"], -32601);
}
