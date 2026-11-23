# RustDesk OSS + WebSocket registration (NeithOS)

This is an AGPL-3.0 fork of **RustDesk Server OSS 1.1.16**, upstream commit
`73523b31cfd25d77dee862e6fc9f5e1fb5e485ef`. It contains no Server Pro code,
license checks or Pro features. The upstream license and copyright are preserved.

Source: https://github.com/rjohny55/neithos-rustdesk-wss

## Changes

- Register device IDs/public keys through the existing WebSocket listener.
  UDP and WS share the same UUID/key validation, rate limits and SQLite storage.
- Keep registration alive using binary heartbeats and echo acknowledgements.
- Route incoming connection notifications to registered WS clients; force relay
  for connections involving a WS peer. Relay data still uses the OSS hbbr.
- Handle online-status queries over WS, reconnects and disconnect cleanup.
- Keep connections from clients behind the same NAT distinct. A disconnected old
  session cannot remove the replacement session's registration.
- Trust X-Real-IP only from networks in the explicit TRUSTED_PROXIES allowlist;
  discard untrusted forwarding headers. WS backend ports must remain private.
- Bound signalling queues (32), WS handshake time (5s), frame/message size (64KiB),
  concurrent WS handlers (1024), write time (5s), idle registration time (30s).
- Update the database before publishing changed keys into the in-memory peer map.

## Client settings for HTTPS reverse proxy

Use a recent official RustDesk client with **Use WebSocket** enabled.
For the example domain:

- ID server: `rast.neithos.ru` (logical default port 21116).
- Relay server: `rast.neithos.ru` (logical default port 21117).
- API server: `https://rast.neithos.ru` to select **wss** in the client.
  This OSS fork does not provide the Pro account/API endpoints; do not try to log
  into an account. The HTTPS scheme selects the secure WebSocket transport.
- Key: the public key from this server's `id_ed25519.pub`.
- Keep TLS verification enabled when the domain has a valid certificate.

Do not set both logical server ports to 443. The client distinguishes ID/relay
by their logical ports and maps the domain to `/ws/id` and `/ws/relay` on HTTPS443.
The reverse proxy forwards these paths to hbbs21118 and hbbr21119. Standard
RustDesk ports need not be forwarded publicly in this WS-only deployment.
Set hbbs `-r rast.neithos.ru:21117`; `TRUSTED_PROXIES` must contain only the
backend-facing proxy address/CIDR. Persist the same server keys for hbbs/hbbr.

## Build and verification

```sh
git clone --recurse-submodules https://github.com/rjohny55/neithos-rustdesk-wss
cd neithos-rustdesk-wss
cargo test --lib ws_sessions
cargo test --lib common::proxy_tests
cargo build --locked --release --bin hbbs --bin hbbr
# Reproducible Docker cross-build (linux/amd64 and linux/arm64 supported):
docker buildx build --platform linux/arm64 -f Dockerfile.neithos -t neithos-rustdesk-wss:arm64 .
```

The upstream `database::tests::test_insert` is a 10,000-insert stress test; it is
not part of the focused transport checks above.

Protocol integration checks require Node.js and `npm install` (only dev dependency
`ws`). Run against an isolated server data directory, not a production database:

```sh
HBBS_WS=ws://127.0.0.1:24118 HBBR_WS=ws://127.0.0.1:24119 \
SERVER_PUBLIC_KEY='<test-server-public-key>' HBBS_UDP_PORT=24116 \
node tests/wss-integration.cjs
```

Checks cover simultaneous registration, UUID mismatch, malformed identities,
incoming call/signalling and signed-key response, wrong keys, reconnect cleanup,
online status, heartbeat beyond 30 seconds, bidirectional relay and UDP regression.
Protocol checks are not a substitute for a desktop-to-desktop user session.
