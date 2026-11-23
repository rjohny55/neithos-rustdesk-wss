//! Bounded routing for registered OSS WebSocket peers. No Pro code is used.
use hbb_common::{
    anyhow::{anyhow, Result}, protobuf::Message, rendezvous_proto::RendezvousMessage,
    tokio::sync::{mpsc, Mutex},
};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use uuid::Uuid;

struct Route { token: Uuid, tx: mpsc::Sender<Vec<u8>> }
#[derive(Default)]
struct Routes {
    sockets: HashMap<SocketAddr, Route>,
    peers: HashMap<String, (SocketAddr, Uuid)>,
}
#[derive(Clone, Default)]
pub(crate) struct WsSessions(Arc<Mutex<Routes>>);
impl WsSessions {
    pub async fn open(&self, addr: SocketAddr) -> Result<(Uuid, mpsc::Receiver<Vec<u8>>)> {
        let mut routes = self.0.lock().await;
        if routes.sockets.contains_key(&addr) { return Err(anyhow!("duplicate WS endpoint")); }
        let token = Uuid::new_v4();
        let (tx, rx) = mpsc::channel(32);
        routes.sockets.insert(addr, Route { token, tx });
        Ok((token, rx))
    }
    pub async fn bind(&self, id: String, addr: SocketAddr, token: Uuid) {
        let mut routes = self.0.lock().await;
        if routes.sockets.get(&addr).map(|r| r.token) == Some(token) {
            routes.peers.insert(id, (addr, token));
        }
    }
    pub async fn owns(&self, id: &str, addr: SocketAddr, token: Uuid) -> bool {
        self.0.lock().await.peers.get(id) == Some(&(addr, token))
    }
    pub async fn contains_peer(&self, id: &str) -> bool {
        self.0.lock().await.peers.contains_key(id)
    }
    pub async fn close(&self, addr: SocketAddr, token: Uuid) -> Option<String> {
        let mut routes = self.0.lock().await;
        if routes.sockets.get(&addr).map(|r| r.token) != Some(token) { return None; }
        routes.sockets.remove(&addr);
        let id = routes.peers.iter().find_map(|(id, binding)|
            (*binding == (addr, token)).then(|| id.clone()));
        if let Some(id) = id.as_ref() { routes.peers.remove(id); }
        id
    }
    /// True also on a full/closed WS queue: never leak that message to UDP.
    pub async fn deliver(&self, addr: SocketAddr, msg: &RendezvousMessage) -> bool {
        let routes = self.0.lock().await;
        if let Some(route) = routes.sockets.get(&addr) {
            if let Ok(bytes) = msg.write_to_bytes() {
                if route.tx.try_send(bytes).is_err() {
                    hbb_common::log::warn!("WS signalling queue unavailable for {}", addr);
                }
            }
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hbb_common::tokio;
    #[hbb_common::tokio::test]
    async fn routes_peers_and_old_disconnect_cannot_remove_replacement() {
        let routes = WsSessions::default();
        let a = "203.0.113.1:10001".parse().unwrap();
        let b = "203.0.113.1:10002".parse().unwrap();
        let (ta, mut rx) = routes.open(a).await.unwrap();
        let (tb, _) = routes.open(b).await.unwrap();
        assert!(routes.open(a).await.is_err());
        routes.bind("123456".into(), a, ta).await;
        assert!(routes.deliver(a, &RendezvousMessage::new()).await);
        assert_eq!(rx.recv().await.unwrap(), Vec::<u8>::new());
        routes.bind("123456".into(), b, tb).await;
        assert_eq!(routes.close(a, ta).await, None);
        assert!(routes.owns("123456", b, tb).await);
        assert_eq!(routes.close(b, tb).await.as_deref(), Some("123456"));
        assert!(!routes.contains_peer("123456").await);
        assert!(!routes.deliver(a, &RendezvousMessage::new()).await);
    }
    #[hbb_common::tokio::test]
    async fn saturated_queue_does_not_fall_back_to_udp() {
        let routes = WsSessions::default();
        let a = "203.0.113.2:12345".parse().unwrap();
        let (_, _rx) = routes.open(a).await.unwrap();
        for _ in 0..40 { assert!(routes.deliver(a, &RendezvousMessage::new()).await); }
    }
}
