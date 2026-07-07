//! SSRF private-address detection — mirrors `test/fetch.test.ts`. This is the
//! security decision the guard makes on the initial URL and every redirect hop,
//! so it is pinned directly. A regression here (a private range that reads as
//! public) is a metadata-exfiltration hole, so the cases are exhaustive.
#![cfg(feature = "network")]

use kcp_planner::is_private_address;

#[test]
fn flags_loopback_private_linklocal_cgnat_and_metadata() {
    for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0"] {
        assert!(is_private_address(ip), "{} should be private", ip);
    }
    assert!(is_private_address("::1")); // loopback
    assert!(is_private_address("fe80::1")); // link-local
    assert!(is_private_address("fc00::1")); // unique-local
    assert!(is_private_address("::ffff:169.254.169.254")); // IPv4-mapped metadata (dotted)
    assert!(is_private_address("::ffff:a9fe:a9fe")); // ...and the hex form a URL parser normalizes to
    assert!(is_private_address("::ffff:0a00:0001")); // ::ffff:10.0.0.1
}

#[test]
fn permits_public_addresses() {
    for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
        assert!(!is_private_address(ip), "{} should be public", ip);
    }
    // A bare hostname is not an address literal — it is resolved-and-checked
    // elsewhere, so the literal classifier reports it public (not an IP).
    assert!(!is_private_address("example.com"));
}
