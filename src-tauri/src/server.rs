use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, Semaphore};
use tower_http::cors::{AllowOrigin, CorsLayer};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const CLIENT_CHANNEL_CAPACITY: usize = 2048;
const MAX_WS_MESSAGE_BYTES: usize = 8 * 1024 * 1024; // 8 MB
const MAX_CONCURRENT_CLIENTS: usize = 16;
const WS_PING_INTERVAL_SECS: u64 = 25;

// Binary wire protocol constants (must stay aligned with src/services/multiplayerService.ts)
const BINARY_MAGIC_0: u8 = 0x49; // 'I'
const BINARY_MAGIC_1: u8 = 0x4e; // 'N'
const BINARY_HEADER_BYTES: usize = 11;

const CODE_STROKE_START: u8 = 0x01;
const CODE_STROKE_CHUNK: u8 = 0x02;
const CODE_STROKE_FINISH: u8 = 0x03;
const CODE_TILE_DELTA: u8 = 0x04;
const CODE_CURSOR_MOVE: u8 = 0x05;
const CODE_SELECTIVE_UNDO: u8 = 0x06;
const CODE_BRUSH_ASSET_DATA: u8 = 0x07;
const CODE_BRUSH_ASSET_REQUEST: u8 = 0x08;
const CODE_LAYER_MASK_DATA: u8 = 0x09;

const TILE_CODEC_EMPTY: u8 = 0;
const TILE_CODEC_RAW: u8 = 1;
const TILE_CODEC_LZ4: u8 = 2;
const TILE_PACKET_HEADER_BYTES: usize = 14;
const MAX_TILE_COORD: i32 = 4096;

const MASK_FLAG_FULL_REPLACE: u8 = 0x01;
const MAX_SYNC_CANVAS_DIM: u32 = 16384;

// Server-side state ceilings (prevent memory exhaustion from rogue or buggy peers)
const MAX_SYNC_LAYERS: usize = 512;
const MAX_SYNC_VECTOR_STROKES: usize = 20_000;
const MAX_OP_LOG_ENTRIES: usize = 4096;
const MAX_OP_LOG_BYTES: usize = 64 * 1024 * 1024; // 64 MB
const MAX_STORED_TILES: usize = 16_384;
const MAX_TILE_STORE_BYTES: usize = 256 * 1024 * 1024; // 256 MB
const MAX_MASK_PACKETS_PER_LAYER: usize = 128;
const MAX_MASK_STORE_BYTES: usize = 32 * 1024 * 1024; // 32 MB

// Per-client message and bandwidth token bucket limits.
// Burst headroom accommodates progressive tile streaming on room join.
const CLIENT_MSG_BURST: f64 = 1000.0;
const CLIENT_MSG_REFILL_PER_SEC: f64 = 400.0;
const CLIENT_BYTES_BURST: f64 = 32.0 * 1024.0 * 1024.0;
const CLIENT_BYTES_REFILL_PER_SEC: f64 = 16.0 * 1024.0 * 1024.0;

// Connection upgrade rate limit to deter token brute-force / connection floods.
const CONNECT_BURST: f64 = 30.0;
const CONNECT_REFILL_PER_SEC: f64 = 5.0;

// Pinned official Cloudflare release for explicit verified installation.
pub const PINNED_CLOUDFLARED_VERSION: &str = "2026.11.1";
pub const PINNED_CLOUDFLARED_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe";
pub const PINNED_CLOUDFLARED_SHA256: &str =
    "341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35";
const MAX_CLOUDFLARED_BYTES: u64 = 100 * 1024 * 1024; // 100 MB ceiling

static NEXT_CLIENT_ID: AtomicUsize = AtomicUsize::new(1);

#[derive(Clone)]
struct ClientHandle {
    tx: mpsc::Sender<Message>,
    kick: Arc<Notify>,
    /// False while a full snapshot / catch-up sync is in flight so live
    /// broadcasts never interleave out of order before the snapshot lands.
    live: bool,
    sync_in_progress: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PeerRole {
    Host,
    Editor,
    Viewer,
}

impl PeerRole {
    fn as_str(self) -> &'static str {
        match self {
            PeerRole::Host => "host",
            PeerRole::Editor => "editor",
            PeerRole::Viewer => "viewer",
        }
    }

    fn from_guest_str(s: &str) -> Option<Self> {
        match s {
            "editor" => Some(PeerRole::Editor),
            "viewer" => Some(PeerRole::Viewer),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
struct PeerRecord {
    client_id: usize,
    id: String,
    name: String,
    is_host: bool,
    role: PeerRole,
    raw: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
struct TileKey {
    layer_id: String,
    tile_x: i32,
    tile_y: i32,
}

#[derive(Clone)]
enum OpPayload {
    Text(Arc<String>),
    Binary(Arc<Vec<u8>>),
}

impl OpPayload {
    fn byte_len(&self) -> usize {
        match self {
            OpPayload::Text(s) => s.len(),
            OpPayload::Binary(b) => b.len(),
        }
    }

    fn to_message(&self) -> Message {
        match self {
            OpPayload::Text(s) => Message::Text((**s).clone()),
            OpPayload::Binary(b) => Message::Binary((**b).clone()),
        }
    }
}

#[derive(Clone)]
struct OpLogEntry {
    seq: u64,
    sender_client_id: Option<usize>,
    payload: OpPayload,
}

#[derive(Clone)]
struct DocumentSnapshot {
    initialized: bool,
    dimensions: serde_json::Value,
    color_mode: String,
    layers: Vec<serde_json::Map<String, serde_json::Value>>,
    perspective_ruler: serde_json::Value,
    straight_ruler: serde_json::Value,
    animation_timeline: serde_json::Value,
}

impl Default for DocumentSnapshot {
    fn default() -> Self {
        Self {
            initialized: false,
            dimensions: serde_json::json!({ "width": 1920, "height": 1080 }),
            color_mode: "color".to_string(),
            layers: Vec::new(),
            perspective_ruler: serde_json::Value::Null,
            straight_ruler: serde_json::Value::Null,
            animation_timeline: serde_json::Value::Null,
        }
    }
}

struct SnapshotSyncPlan {
    snapshot_seq: u64,
    join_accepted: Option<String>,
    doc_sync_response: String,
    tiles: Vec<Arc<Vec<u8>>>,
    masks: Vec<Arc<Vec<u8>>>,
}

enum SyncPlan {
    Full(SnapshotSyncPlan),
    Incremental {
        join_accepted: Option<String>,
        since_seq: u64,
    },
}

enum HandleTextOutcome {
    None,
    PeerRegistered(String),
    StartSync {
        peer_id: Option<String>,
        plan: SyncPlan,
    },
}

struct RoomState {
    room_name: String,
    seq: u64,
    clients: HashMap<usize, ClientHandle>,
    peers: HashMap<usize, PeerRecord>,
    /// Persistent role assignment per peerId across reconnects (prevents viewer bypass via reconnect).
    peer_roles: HashMap<String, PeerRole>,
    /// Permanently banned peerIds for this room session.
    banned_peer_ids: HashSet<String>,
    host_client_id: Option<usize>,
    host_peer_id: Option<String>,
    doc: DocumentSnapshot,
    tiles: HashMap<TileKey, Arc<Vec<u8>>>,
    tile_store_bytes: usize,
    masks: HashMap<String, Vec<Arc<Vec<u8>>>>,
    mask_store_bytes: usize,
    op_log: VecDeque<OpLogEntry>,
    op_log_bytes: usize,
    /// Highest `seq` evicted from `op_log` or replaced by a full document seed.
    /// Incremental replay from `since_seq` is safe iff `since_seq >= op_log_floor && since_seq <= seq`.
    op_log_floor: u64,
}

impl RoomState {
    fn new(room_name: String) -> Self {
        Self {
            room_name,
            seq: 0,
            clients: HashMap::new(),
            peers: HashMap::new(),
            peer_roles: HashMap::new(),
            banned_peer_ids: HashSet::new(),
            host_client_id: None,
            host_peer_id: None,
            doc: DocumentSnapshot::default(),
            tiles: HashMap::new(),
            tile_store_bytes: 0,
            masks: HashMap::new(),
            mask_store_bytes: 0,
            op_log: VecDeque::new(),
            op_log_bytes: 0,
            op_log_floor: 0,
        }
    }

    #[inline]
    fn is_host_client(&self, client_id: usize) -> bool {
        self.host_client_id == Some(client_id)
    }

    #[inline]
    fn client_role(&self, client_id: usize) -> PeerRole {
        if self.is_host_client(client_id) {
            return PeerRole::Host;
        }
        self.peers
            .get(&client_id)
            .map(|p| p.role)
            .unwrap_or(PeerRole::Editor)
    }

    #[inline]
    fn client_peer_id(&self, client_id: usize) -> Option<&str> {
        self.peers.get(&client_id).map(|p| p.id.as_str())
    }

    fn send_direct(&self, client_id: usize, msg: Message) {
        if let Some(c) = self.clients.get(&client_id) {
            let _ = c.tx.try_send(msg);
        }
    }

    fn send_access_denied(&self, client_id: usize, code: &str, reason: &str, target_peer_id: Option<&str>) {
        let mut payload = serde_json::json!({
            "type": "ACCESS_DENIED",
            "code": code,
            "reason": reason,
        });
        if let Some(pid) = target_peer_id {
            payload["targetPeerId"] = serde_json::Value::String(pid.to_string());
        }
        self.send_direct(client_id, Message::Text(payload.to_string()));
    }

    fn can_mutate_canvas(&self, client_id: usize) -> Result<(), (&'static str, &'static str)> {
        if self.client_role(client_id) == PeerRole::Viewer {
            return Err(("VIEWER_READONLY", "Viewers have read-only access"));
        }
        Ok(())
    }

    fn can_modify_layer(
        &self,
        client_id: usize,
        layer_id: &str,
    ) -> Result<(), (&'static str, String)> {
        let role = self.client_role(client_id);
        if role == PeerRole::Viewer {
            return Err(("VIEWER_READONLY", "Viewers have read-only access".to_string()));
        }
        if role == PeerRole::Host {
            return Ok(());
        }
        let sender_peer_id = self.client_peer_id(client_id);
        if let Some(layer) = self
            .doc
            .layers
            .iter()
            .find(|l| layer_id_of(l) == Some(layer_id))
        {
            if let Some(reserved_by) = layer.get("reservedByPeerId").and_then(value_to_peer_id) {
                if sender_peer_id != Some(reserved_by.as_str()) {
                    let owner_name = layer
                        .get("reservedByPeerName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("its owner");
                    return Err((
                        "LAYER_LOCKED",
                        format!("Layer is locked by {}", owner_name),
                    ));
                }
            }
        }
        Ok(())
    }

    fn collect_layer_subtree_ids(&self, root_id: &str) -> HashSet<String> {
        let mut deleted: HashSet<String> = HashSet::new();
        deleted.insert(root_id.to_string());
        loop {
            let mut added_any = false;
            for l in &self.doc.layers {
                let Some(lid) = layer_id_of(l) else {
                    continue;
                };
                if deleted.contains(lid) {
                    continue;
                }
                if let Some(pid) = l.get("parentId").and_then(|v| v.as_str()) {
                    if deleted.contains(pid) {
                        deleted.insert(lid.to_string());
                        added_any = true;
                    }
                }
            }
            if !added_any {
                break;
            }
        }
        deleted
    }

    fn can_delete_layer(
        &self,
        client_id: usize,
        layer_id: &str,
    ) -> Result<(), (&'static str, String)> {
        let role = self.client_role(client_id);
        if role == PeerRole::Viewer {
            return Err(("VIEWER_READONLY", "Viewers cannot delete layers".to_string()));
        }
        if role == PeerRole::Host {
            return Ok(());
        }
        let sender_peer_id = self.client_peer_id(client_id);
        let target_ids = self.collect_layer_subtree_ids(layer_id);
        for layer in &self.doc.layers {
            let Some(lid) = layer_id_of(layer) else {
                continue;
            };
            if !target_ids.contains(lid) {
                continue;
            }
            let lname = layer
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Layer");
            if let Some(reserved_by) = layer.get("reservedByPeerId").and_then(value_to_peer_id) {
                if sender_peer_id != Some(reserved_by.as_str()) {
                    let lock_name = layer
                        .get("reservedByPeerName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("another user");
                    return Err((
                        "LAYER_LOCKED",
                        format!("Cannot delete \"{}\" — locked by {}", lname, lock_name),
                    ));
                }
            }
            if let Some(owner_id) = layer.get("ownerPeerId").and_then(value_to_peer_id) {
                if sender_peer_id != Some(owner_id.as_str()) {
                    let owner_name = layer
                        .get("ownerPeerName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("another user");
                    return Err((
                        "NOT_OWNER",
                        format!("Cannot delete \"{}\" — owned by {}", lname, owner_name),
                    ));
                }
            }
        }
        Ok(())
    }

    fn release_peer_locks(&mut self, target_peer_id: &str) {
        let mut unlocked_ids: Vec<String> = Vec::new();
        for layer in &mut self.doc.layers {
            let matches_lock = layer
                .get("reservedByPeerId")
                .and_then(value_to_peer_id)
                .map_or(false, |id| id == target_peer_id);
            if matches_lock {
                layer.remove("reservedByPeerId");
                layer.remove("reservedByPeerName");
                if let Some(lid) = layer_id_of(layer) {
                    unlocked_ids.push(lid.to_string());
                }
            }
        }
        for lid in unlocked_ids {
            let seq = self.next_seq();
            let upd = serde_json::json!({
                "type": "LAYER_UPDATE",
                "seq": seq,
                "layerId": lid,
                "patch": {},
                "clearedFields": ["reservedByPeerId", "reservedByPeerName"],
            });
            let text = Arc::new(upd.to_string());
            self.push_op_log(seq, None, OpPayload::Text(Arc::clone(&text)));
            self.broadcast_live(None, Message::Text((*text).clone()));
        }
    }

    fn kick_clients_for_peer(&mut self, target_peer_id: &str, code: &str, reason: &str) {
        let matching_cids: Vec<usize> = self
            .peers
            .iter()
            .filter(|(_, p)| p.id == target_peer_id)
            .map(|(&cid, _)| cid)
            .collect();
        for cid in matching_cids {
            self.send_access_denied(cid, code, reason, Some(target_peer_id));
            if let Some(removed) = self.clients.remove(&cid) {
                removed.kick.notify_one();
            }
            self.peers.remove(&cid);
        }
    }

    #[inline]
    fn next_seq(&mut self) -> u64 {
        self.seq = self.seq.saturating_add(1);
        self.seq
    }

    fn push_op_log(&mut self, seq: u64, sender_client_id: Option<usize>, payload: OpPayload) {
        let size = payload.byte_len();
        if size > MAX_OP_LOG_BYTES {
            self.op_log.clear();
            self.op_log_bytes = 0;
            self.op_log_floor = seq;
            return;
        }
        while !self.op_log.is_empty()
            && (self.op_log.len() >= MAX_OP_LOG_ENTRIES
                || self.op_log_bytes.saturating_add(size) > MAX_OP_LOG_BYTES)
        {
            if let Some(evicted) = self.op_log.pop_front() {
                self.op_log_bytes = self.op_log_bytes.saturating_sub(evicted.payload.byte_len());
                self.op_log_floor = self.op_log_floor.max(evicted.seq);
            }
        }
        self.op_log_bytes = self.op_log_bytes.saturating_add(size);
        self.op_log.push_back(OpLogEntry {
            seq,
            sender_client_id,
            payload,
        });
    }

    fn broadcast_live(&mut self, sender_id: Option<usize>, msg: Message) {
        let mut slow_ids: Vec<usize> = Vec::new();
        for (&id, peer) in self.clients.iter() {
            if Some(id) == sender_id || !peer.live {
                continue;
            }
            if peer.tx.try_send(msg.clone()).is_err() {
                slow_ids.push(id);
            }
        }
        for id in slow_ids {
            if let Some(removed) = self.clients.remove(&id) {
                removed.kick.notify_one();
            }
        }
    }

    fn prune_layer_tiles(&mut self, layer_id: &str) {
        let mut freed = 0usize;
        self.tiles.retain(|k, v| {
            if k.layer_id == layer_id {
                freed = freed.saturating_add(v.len());
                false
            } else {
                true
            }
        });
        self.tile_store_bytes = self.tile_store_bytes.saturating_sub(freed);
    }

    fn prune_layer_masks(&mut self, layer_id: &str) {
        if let Some(removed) = self.masks.remove(layer_id) {
            let freed: usize = removed.iter().map(|p| p.len()).sum();
            self.mask_store_bytes = self.mask_store_bytes.saturating_sub(freed);
        }
    }

    fn prune_orphaned_layer_data(&mut self) {
        let live_ids: HashSet<&str> = self
            .doc
            .layers
            .iter()
            .filter_map(layer_id_of)
            .collect();
        let masked_ids: HashSet<&str> = self
            .doc
            .layers
            .iter()
            .filter(|l| l.get("hasMask").and_then(|v| v.as_bool()).unwrap_or(false))
            .filter_map(layer_id_of)
            .collect();

        let mut freed_tiles = 0usize;
        self.tiles.retain(|k, v| {
            if live_ids.contains(k.layer_id.as_str()) {
                true
            } else {
                freed_tiles = freed_tiles.saturating_add(v.len());
                false
            }
        });
        self.tile_store_bytes = self.tile_store_bytes.saturating_sub(freed_tiles);

        let mut freed_masks = 0usize;
        self.masks.retain(|lid, packets| {
            if live_ids.contains(lid.as_str()) && masked_ids.contains(lid.as_str()) {
                true
            } else {
                freed_masks = freed_masks.saturating_add(packets.iter().map(|p| p.len()).sum::<usize>());
                false
            }
        });
        self.mask_store_bytes = self.mask_store_bytes.saturating_sub(freed_masks);
    }

    fn apply_doc_sync_response(&mut self, obj: &serde_json::Map<String, serde_json::Value>) -> bool {
        let Some(layers_val) = obj.get("layers").and_then(|v| v.as_array()) else {
            return false;
        };
        let Some(dims_obj) = obj.get("dimensions").and_then(|v| v.as_object()) else {
            return false;
        };
        let w = dims_obj.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let h = dims_obj.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if !w.is_finite()
            || !h.is_finite()
            || w < 1.0
            || h < 1.0
            || w > MAX_SYNC_CANVAS_DIM as f64
            || h > MAX_SYNC_CANVAS_DIM as f64
        {
            return false;
        }

        let sanitized_layers = sanitize_layer_tree_objects(layers_val);
        if sanitized_layers.is_empty() {
            return false;
        }

        let color_mode = match obj.get("colorMode").and_then(|v| v.as_str()) {
            Some("grayscale") => "grayscale".to_string(),
            Some("monochrome") => "monochrome".to_string(),
            _ => "color".to_string(),
        };

        self.doc.dimensions = serde_json::Value::Object(dims_obj.clone());
        self.doc.color_mode = color_mode;
        self.doc.layers = sanitized_layers;
        self.doc.perspective_ruler = obj
            .get("perspectiveRuler")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        self.doc.straight_ruler = obj
            .get("straightRuler")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        self.doc.animation_timeline = obj
            .get("animationTimeline")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        self.doc.initialized = true;
        self.prune_orphaned_layer_data();
        true
    }

    fn ensure_guest_layer(&mut self, peer: &PeerRecord, client_id: usize) -> Option<String> {
        let layer_id = format!("layer-{}-1", peer.id);
        if self
            .doc
            .layers
            .iter()
            .any(|l| layer_id_of(l) == Some(layer_id.as_str()))
        {
            return Some(layer_id);
        }
        if self.doc.layers.len() >= MAX_SYNC_LAYERS {
            return None;
        }

        let layer_name = next_collab_layer_name(&peer.name, &self.doc.layers);
        let mut layer_obj = serde_json::Map::new();
        layer_obj.insert("id".to_string(), serde_json::Value::String(layer_id.clone()));
        layer_obj.insert("name".to_string(), serde_json::Value::String(layer_name));
        layer_obj.insert("type".to_string(), serde_json::Value::String("raster".to_string()));
        layer_obj.insert("visible".to_string(), serde_json::Value::Bool(true));
        layer_obj.insert("opacity".to_string(), serde_json::json!(1.0));
        layer_obj.insert("blendMode".to_string(), serde_json::Value::String("normal".to_string()));
        layer_obj.insert("locked".to_string(), serde_json::Value::Bool(false));
        layer_obj.insert("parentId".to_string(), serde_json::Value::Null);
        layer_obj.insert("ownerPeerId".to_string(), serde_json::Value::String(peer.id.clone()));
        layer_obj.insert("ownerPeerName".to_string(), serde_json::Value::String(peer.name.clone()));

        self.doc.layers.insert(0, layer_obj.clone());

        let seq = self.next_seq();
        let layer_add = serde_json::json!({
            "type": "LAYER_ADD",
            "seq": seq,
            "layerId": layer_id,
            "layerItem": serde_json::Value::Object(layer_obj),
            "insertIndex": 0,
        });
        let text = Arc::new(layer_add.to_string());
        self.push_op_log(seq, Some(client_id), OpPayload::Text(Arc::clone(&text)));
        self.broadcast_live(Some(client_id), Message::Text((*text).clone()));

        Some(layer_id)
    }

    fn build_join_accepted_json(
        &self,
        client_id: usize,
        target_peer_id: &str,
        assigned_layer_id: Option<&str>,
        assigned_role: PeerRole,
        is_reconnect: bool,
        seq: u64,
    ) -> String {
        let other_peers: Vec<serde_json::Value> = self
            .peers
            .values()
            .filter(|p| p.client_id != client_id)
            .map(|p| serde_json::Value::Object(p.raw.clone()))
            .collect();
        let host_id = self.host_peer_id.clone().unwrap_or_default();
        serde_json::json!({
            "type": "JOIN_ACCEPTED",
            "seq": seq,
            "serverSeq": seq,
            "targetPeerId": target_peer_id,
            "roomName": self.room_name,
            "peers": other_peers,
            "hostId": host_id,
            "docDimensions": self.doc.dimensions,
            "colorMode": self.doc.color_mode,
            "assignedLayerId": assigned_layer_id,
            "assignedRole": assigned_role.as_str(),
            "isReconnect": is_reconnect,
        })
        .to_string()
    }

    fn build_full_sync_plan(
        &mut self,
        client_id: usize,
        target_peer_id: &str,
        assigned_layer_id: Option<String>,
        include_join_accepted: bool,
        is_reconnect: bool,
    ) -> SyncPlan {
        if let Some(c) = self.clients.get_mut(&client_id) {
            c.live = false;
            c.sync_in_progress = true;
        }

        let snapshot_seq = self.seq;
        let assigned_role = self.client_role(client_id);
        let join_accepted = if include_join_accepted {
            Some(self.build_join_accepted_json(
                client_id,
                target_peer_id,
                assigned_layer_id.as_deref(),
                assigned_role,
                is_reconnect,
                snapshot_seq,
            ))
        } else {
            None
        };

        let layers_json: Vec<serde_json::Value> = self
            .doc
            .layers
            .iter()
            .cloned()
            .map(serde_json::Value::Object)
            .collect();
        let doc_sync_response = serde_json::json!({
            "type": "DOC_SYNC_RESPONSE",
            "seq": snapshot_seq,
            "targetPeerId": target_peer_id,
            "roomName": self.room_name,
            "assignedLayerId": assigned_layer_id,
            "dimensions": self.doc.dimensions,
            "colorMode": self.doc.color_mode,
            "layers": layers_json,
            "perspectiveRuler": self.doc.perspective_ruler,
            "straightRuler": self.doc.straight_ruler,
            "animationTimeline": self.doc.animation_timeline,
        })
        .to_string();

        let mut tile_entries: Vec<(&TileKey, &Arc<Vec<u8>>)> = self.tiles.iter().collect();
        tile_entries.sort_by(|(ka, _), (kb, _)| ka.cmp(kb));
        let tiles: Vec<Arc<Vec<u8>>> = tile_entries
            .into_iter()
            .map(|(_, v)| Arc::clone(v))
            .collect();

        let mut mask_entries: Vec<(&String, &Vec<Arc<Vec<u8>>>)> = self.masks.iter().collect();
        mask_entries.sort_by(|(ka, _), (kb, _)| ka.cmp(kb));
        let mut masks = Vec::new();
        for (_, pkts) in mask_entries {
            for pkt in pkts {
                masks.push(Arc::clone(pkt));
            }
        }

        SyncPlan::Full(SnapshotSyncPlan {
            snapshot_seq,
            join_accepted,
            doc_sync_response,
            tiles,
            masks,
        })
    }

    fn apply_layer_add(&mut self, obj: &serde_json::Map<String, serde_json::Value>) {
        if self.doc.layers.len() >= MAX_SYNC_LAYERS {
            return;
        }
        let Some(item_obj) = obj.get("layerItem").and_then(|v| v.as_object()) else {
            return;
        };
        let Some(clean) = sanitize_layer_object(item_obj) else {
            return;
        };
        let Some(new_id) = layer_id_of(&clean) else {
            return;
        };
        if self.doc.layers.iter().any(|l| layer_id_of(l) == Some(new_id)) {
            return;
        }

        if let Some(idx) = obj.get("insertIndex").and_then(|v| v.as_u64()) {
            let pos = (idx as usize).min(self.doc.layers.len());
            self.doc.layers.insert(pos, clean);
        } else if let Some(bg_idx) = self
            .doc
            .layers
            .iter()
            .position(|l| layer_id_of(l).map_or(false, is_background_layer_id))
        {
            self.doc.layers.insert(bg_idx, clean);
        } else {
            self.doc.layers.push(clean);
        }
    }

    fn apply_layer_delete(&mut self, obj: &serde_json::Map<String, serde_json::Value>) {
        let Some(target_id) = obj.get("layerId").and_then(|v| v.as_str()) else {
            return;
        };
        if target_id.is_empty() || target_id.len() > 256 {
            return;
        }

        // Collect target + all transitive children (matching computeBatchDeleteLayers)
        let mut deleted: HashSet<String> = HashSet::new();
        deleted.insert(target_id.to_string());
        loop {
            let mut added_any = false;
            for l in &self.doc.layers {
                let Some(lid) = layer_id_of(l) else {
                    continue;
                };
                if deleted.contains(lid) {
                    continue;
                }
                if let Some(pid) = l.get("parentId").and_then(|v| v.as_str()) {
                    if deleted.contains(pid) {
                        deleted.insert(lid.to_string());
                        added_any = true;
                    }
                }
            }
            if !added_any {
                break;
            }
        }

        self.doc
            .layers
            .retain(|l| layer_id_of(l).map_or(true, |id| !deleted.contains(id)));
        for del_id in &deleted {
            self.prune_layer_tiles(del_id);
            self.prune_layer_masks(del_id);
        }
    }

    fn apply_layer_clear(&mut self, obj: &serde_json::Map<String, serde_json::Value>) {
        let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()) else {
            return;
        };
        if layer_id.is_empty() || layer_id.len() > 256 {
            return;
        }
        if let Some(layer) = self
            .doc
            .layers
            .iter_mut()
            .find(|l| layer_id_of(l) == Some(layer_id))
        {
            if layer.get("type").and_then(|v| v.as_str()) == Some("vector") {
                layer.insert("vectorStrokes".to_string(), serde_json::Value::Array(Vec::new()));
            }
        }
        if !is_background_layer_id(layer_id) {
            self.prune_layer_tiles(layer_id);
        }
    }

    fn apply_layer_update(&mut self, obj: &serde_json::Map<String, serde_json::Value>) {
        let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()) else {
            return;
        };
        let mut mask_removed = false;
        if let Some(layer) = self
            .doc
            .layers
            .iter_mut()
            .find(|l| layer_id_of(l) == Some(layer_id))
        {
            if let Some(patch) = obj.get("patch").and_then(|v| v.as_object()) {
                for (k, v) in patch {
                    if is_forbidden_json_key(k) || k == "id" {
                        continue;
                    }
                    if k == "hasMask" && v.as_bool() == Some(false) {
                        mask_removed = true;
                    }
                    layer.insert(k.clone(), v.clone());
                }
            }
            if let Some(cleared) = obj.get("clearedFields").and_then(|v| v.as_array()) {
                for field in cleared.iter().take(64) {
                    if let Some(fname) = field.as_str() {
                        if fname == "id" || is_forbidden_json_key(fname) {
                            continue;
                        }
                        if fname == "hasMask" {
                            mask_removed = true;
                        }
                        layer.remove(fname);
                    }
                }
            }
        }
        if mask_removed {
            self.prune_layer_masks(layer_id);
        }
    }

    fn handle_text_object(
        &mut self,
        client_id: usize,
        mut obj: serde_json::Map<String, serde_json::Value>,
    ) -> HandleTextOutcome {
        let Some(msg_type) = obj
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        else {
            return HandleTextOutcome::None;
        };

        match msg_type.as_str() {
            "JOIN_REQUEST" => {
                let Some(mut peer) = parse_peer_from_join(&obj, client_id) else {
                    return HandleTextOutcome::None;
                };

                // Reject banned peerIds immediately before registering or leaking room state
                if self.banned_peer_ids.contains(&peer.id) {
                    self.send_access_denied(
                        client_id,
                        "BANNED",
                        "You are banned from this room",
                        Some(&peer.id),
                    );
                    if let Some(removed) = self.clients.remove(&client_id) {
                        removed.kick.notify_one();
                    }
                    return HandleTextOutcome::None;
                }

                // Prevent host-claim hijacking while the real host is briefly disconnected
                let is_host_claim = peer.is_host
                    && (self.host_peer_id.is_none()
                        || self.host_peer_id.as_deref() == Some(peer.id.as_str()))
                    && (self.host_client_id.is_none() || self.host_client_id == Some(client_id));

                let assigned_role = if is_host_claim {
                    PeerRole::Host
                } else {
                    match self.peer_roles.get(&peer.id).copied() {
                        Some(PeerRole::Viewer) => PeerRole::Viewer,
                        _ => {
                            self.peer_roles.insert(peer.id.clone(), PeerRole::Editor);
                            PeerRole::Editor
                        }
                    }
                };

                peer.is_host = is_host_claim;
                peer.role = assigned_role;
                peer.raw
                    .insert("isHost".to_string(), serde_json::Value::Bool(is_host_claim));
                peer.raw.insert(
                    "role".to_string(),
                    serde_json::Value::String(assigned_role.as_str().to_string()),
                );

                if is_host_claim {
                    self.host_client_id = Some(client_id);
                    self.host_peer_id = Some(peer.id.clone());
                }
                self.peers.insert(client_id, peer.clone());

                let is_reconnect = obj
                    .get("isReconnect")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let since_seq = obj.get("sinceSeq").and_then(|v| v.as_u64());

                if is_host_claim {
                    if is_reconnect && self.doc.initialized {
                        if let Some(s) = since_seq {
                            if s >= self.op_log_floor && s <= self.seq {
                                if let Some(c) = self.clients.get_mut(&client_id) {
                                    c.live = false;
                                    c.sync_in_progress = true;
                                }
                                return HandleTextOutcome::StartSync {
                                    peer_id: Some(peer.id),
                                    plan: SyncPlan::Incremental {
                                        join_accepted: None,
                                        since_seq: s,
                                    },
                                };
                            }
                            if s < self.op_log_floor {
                                let plan = self.build_full_sync_plan(
                                    client_id,
                                    &peer.id,
                                    None,
                                    false,
                                    true,
                                );
                                return HandleTextOutcome::StartSync {
                                    peer_id: Some(peer.id),
                                    plan,
                                };
                            }
                        }
                    }
                    return HandleTextOutcome::PeerRegistered(peer.id);
                }

                if self.doc.initialized {
                    let already_syncing = self
                        .clients
                        .get(&client_id)
                        .map_or(true, |c| c.sync_in_progress);
                    if already_syncing {
                        return HandleTextOutcome::PeerRegistered(peer.id);
                    }

                    let assigned_layer_id = if assigned_role == PeerRole::Viewer {
                        None
                    } else {
                        self.ensure_guest_layer(&peer, client_id)
                    };

                    let join_seq = self.next_seq();
                    let peer_joined = serde_json::json!({
                        "type": "PEER_JOINED",
                        "seq": join_seq,
                        "peer": serde_json::Value::Object(peer.raw.clone()),
                    });
                    let pj_text = Arc::new(peer_joined.to_string());
                    self.push_op_log(
                        join_seq,
                        Some(client_id),
                        OpPayload::Text(Arc::clone(&pj_text)),
                    );
                    self.broadcast_live(Some(client_id), Message::Text((*pj_text).clone()));

                    // Incremental catch-up by seq on reconnect when op_log still covers since_seq
                    if is_reconnect {
                        if let Some(s) = since_seq {
                            if s >= self.op_log_floor && s <= self.seq {
                                let join_acc = self.build_join_accepted_json(
                                    client_id,
                                    &peer.id,
                                    assigned_layer_id.as_deref(),
                                    assigned_role,
                                    true,
                                    self.seq,
                                );
                                if let Some(c) = self.clients.get_mut(&client_id) {
                                    c.live = false;
                                    c.sync_in_progress = true;
                                }
                                return HandleTextOutcome::StartSync {
                                    peer_id: Some(peer.id),
                                    plan: SyncPlan::Incremental {
                                        join_accepted: Some(join_acc),
                                        since_seq: s,
                                    },
                                };
                            }
                        }
                    }

                    let plan = self.build_full_sync_plan(
                        client_id,
                        &peer.id,
                        assigned_layer_id,
                        true,
                        is_reconnect,
                    );
                    return HandleTextOutcome::StartSync {
                        peer_id: Some(peer.id),
                        plan,
                    };
                }

                // Fallback when host has not yet seeded the server snapshot
                let seq = self.next_seq();
                obj.insert("seq".to_string(), serde_json::Value::from(seq));
                let text = serde_json::Value::Object(obj).to_string();
                self.broadcast_live(Some(client_id), Message::Text(text));
                HandleTextOutcome::PeerRegistered(peer.id)
            }

            "DOC_SYNC_REQUEST" => {
                if self.doc.initialized {
                    let already_syncing = self
                        .clients
                        .get(&client_id)
                        .map_or(true, |c| c.sync_in_progress);
                    if already_syncing {
                        return HandleTextOutcome::None;
                    }

                    if let Some(since_seq) = obj.get("sinceSeq").and_then(|v| v.as_u64()) {
                        if since_seq >= self.op_log_floor && since_seq <= self.seq {
                            if let Some(c) = self.clients.get_mut(&client_id) {
                                c.live = false;
                                c.sync_in_progress = true;
                            }
                            return HandleTextOutcome::StartSync {
                                peer_id: None,
                                plan: SyncPlan::Incremental {
                                    join_accepted: None,
                                    since_seq,
                                },
                            };
                        }
                    }

                    let target_peer_id = obj
                        .get("targetPeerId")
                        .and_then(value_to_peer_id)
                        .or_else(|| self.peers.get(&client_id).map(|p| p.id.clone()))
                        .unwrap_or_default();
                    let plan = self.build_full_sync_plan(
                        client_id,
                        &target_peer_id,
                        None,
                        false,
                        false,
                    );
                    return HandleTextOutcome::StartSync {
                        peer_id: None,
                        plan,
                    };
                }

                // Fallback relay when server snapshot is not initialized
                let seq = self.next_seq();
                obj.insert("seq".to_string(), serde_json::Value::from(seq));
                let text = serde_json::Value::Object(obj).to_string();
                self.broadcast_live(Some(client_id), Message::Text(text));
                HandleTextOutcome::None
            }

            "PEER_ROLE_UPDATE" => {
                if !self.is_host_client(client_id) {
                    self.send_access_denied(
                        client_id,
                        "FORBIDDEN",
                        "Only the Host can change participant roles",
                        None,
                    );
                    return HandleTextOutcome::None;
                }
                let Some(target_peer_id) = obj.get("targetPeerId").and_then(value_to_peer_id)
                else {
                    return HandleTextOutcome::None;
                };
                if self.host_peer_id.as_deref() == Some(target_peer_id.as_str()) {
                    return HandleTextOutcome::None;
                }
                let Some(role_str) = obj.get("role").and_then(|v| v.as_str()) else {
                    return HandleTextOutcome::None;
                };
                let Some(next_role) = PeerRole::from_guest_str(role_str) else {
                    return HandleTextOutcome::None;
                };
                self.peer_roles.insert(target_peer_id.clone(), next_role);
                for peer in self.peers.values_mut() {
                    if peer.id == target_peer_id {
                        peer.role = next_role;
                        peer.raw.insert(
                            "role".to_string(),
                            serde_json::Value::String(next_role.as_str().to_string()),
                        );
                    }
                }
                obj.insert(
                    "role".to_string(),
                    serde_json::Value::String(next_role.as_str().to_string()),
                );
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "PEER_KICK" => {
                if !self.is_host_client(client_id) {
                    self.send_access_denied(
                        client_id,
                        "FORBIDDEN",
                        "Only the Host can kick participants",
                        None,
                    );
                    return HandleTextOutcome::None;
                }
                let Some(target_peer_id) = obj.get("targetPeerId").and_then(value_to_peer_id)
                else {
                    return HandleTextOutcome::None;
                };
                if self.host_peer_id.as_deref() == Some(target_peer_id.as_str()) {
                    return HandleTextOutcome::None;
                }
                let reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().chars().take(256).collect::<String>())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "You were kicked by the host".to_string());

                self.release_peer_locks(&target_peer_id);
                self.kick_clients_for_peer(&target_peer_id, "KICKED", &reason);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "PEER_BAN" => {
                if !self.is_host_client(client_id) {
                    self.send_access_denied(
                        client_id,
                        "FORBIDDEN",
                        "Only the Host can ban participants",
                        None,
                    );
                    return HandleTextOutcome::None;
                }
                let Some(target_peer_id) = obj.get("targetPeerId").and_then(value_to_peer_id)
                else {
                    return HandleTextOutcome::None;
                };
                if self.host_peer_id.as_deref() == Some(target_peer_id.as_str()) {
                    return HandleTextOutcome::None;
                }
                let reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().chars().take(256).collect::<String>())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "You have been banned from this room".to_string());

                self.banned_peer_ids.insert(target_peer_id.clone());
                self.release_peer_locks(&target_peer_id);
                self.kick_clients_for_peer(&target_peer_id, "BANNED", &reason);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "PEER_UNBAN" => {
                if !self.is_host_client(client_id) {
                    self.send_access_denied(
                        client_id,
                        "FORBIDDEN",
                        "Only the Host can unban participants",
                        None,
                    );
                    return HandleTextOutcome::None;
                }
                if let Some(target_peer_id) = obj.get("targetPeerId").and_then(value_to_peer_id) {
                    self.banned_peer_ids.remove(&target_peer_id);
                    self.commit_and_broadcast_text(client_id, obj, false);
                }
                HandleTextOutcome::None
            }

            "DOC_SYNC_RESPONSE" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                let can_seed = !self.doc.initialized || self.host_client_id == Some(client_id);
                let seeded = if can_seed {
                    self.apply_doc_sync_response(&obj)
                } else {
                    false
                };

                let target = obj
                    .get("targetPeerId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if target.is_empty() || target == "__server__" {
                    if seeded {
                        let seq = self.next_seq();
                        // Snapshot replaces prior baseline; clients behind `seq` need full sync
                        self.op_log.clear();
                        self.op_log_bytes = 0;
                        self.op_log_floor = seq;
                    }
                    return HandleTextOutcome::None;
                }

                // Only host (or initial unseeded responder) may broadcast DOC_SYNC_RESPONSE
                if !can_seed {
                    return HandleTextOutcome::None;
                }

                let seq = self.next_seq();
                if seeded {
                    self.op_log_floor = self.op_log_floor.max(seq);
                }
                obj.insert("seq".to_string(), serde_json::Value::from(seq));
                let text = serde_json::Value::Object(obj).to_string();
                self.broadcast_live(Some(client_id), Message::Text(text));
                HandleTextOutcome::None
            }

            "LAYER_ADD" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                // Stamp authoritative ownerPeerId for non-host editors so ownership cannot be spoofed
                if !self.is_host_client(client_id) {
                    if let Some(peer) = self.peers.get(&client_id).cloned() {
                        if let Some(item) = obj.get_mut("layerItem").and_then(|v| v.as_object_mut())
                        {
                            item.insert(
                                "ownerPeerId".to_string(),
                                serde_json::Value::String(peer.id),
                            );
                            item.insert(
                                "ownerPeerName".to_string(),
                                serde_json::Value::String(peer.name),
                            );
                        }
                    }
                }
                self.apply_layer_add(&obj);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_DELETE" => {
                if let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()) {
                    if let Err((code, reason)) = self.can_delete_layer(client_id, layer_id) {
                        self.send_access_denied(client_id, code, &reason, None);
                        return HandleTextOutcome::None;
                    }
                } else {
                    return HandleTextOutcome::None;
                }
                self.apply_layer_delete(&obj);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_CLEAR" => {
                if let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()) {
                    if let Err((code, reason)) = self.can_modify_layer(client_id, layer_id) {
                        self.send_access_denied(client_id, code, &reason, None);
                        return HandleTextOutcome::None;
                    }
                } else {
                    return HandleTextOutcome::None;
                }
                self.apply_layer_clear(&obj);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_RENAME" => {
                let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    return HandleTextOutcome::None;
                };
                if let Err((code, reason)) = self.can_modify_layer(client_id, &layer_id) {
                    self.send_access_denied(client_id, code, &reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(new_name) = obj.get("newName").and_then(|v| v.as_str()) {
                    let safe_name: String = new_name.chars().take(256).collect();
                    if let Some(layer) = self
                        .doc
                        .layers
                        .iter_mut()
                        .find(|l| layer_id_of(l) == Some(layer_id.as_str()))
                    {
                        layer.insert("name".to_string(), serde_json::Value::String(safe_name));
                    }
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_VISIBILITY" => {
                let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    return HandleTextOutcome::None;
                };
                if let Err((code, reason)) = self.can_modify_layer(client_id, &layer_id) {
                    self.send_access_denied(client_id, code, &reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(visible) = obj.get("visible").and_then(|v| v.as_bool()) {
                    if let Some(layer) = self
                        .doc
                        .layers
                        .iter_mut()
                        .find(|l| layer_id_of(l) == Some(layer_id.as_str()))
                    {
                        layer.insert("visible".to_string(), serde_json::Value::Bool(visible));
                    }
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_OPACITY" => {
                let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    return HandleTextOutcome::None;
                };
                if let Err((code, reason)) = self.can_modify_layer(client_id, &layer_id) {
                    self.send_access_denied(client_id, code, &reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(opacity) = obj.get("opacity").and_then(|v| v.as_f64()) {
                    if opacity.is_finite() {
                        let clamped = opacity.clamp(0.0, 1.0);
                        if let Some(layer) = self
                            .doc
                            .layers
                            .iter_mut()
                            .find(|l| layer_id_of(l) == Some(layer_id.as_str()))
                        {
                            layer.insert("opacity".to_string(), serde_json::json!(clamped));
                        }
                    }
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_UPDATE" => {
                let Some(layer_id) = obj.get("layerId").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
                    return HandleTextOutcome::None;
                };
                if let Err((code, reason)) = self.can_modify_layer(client_id, &layer_id) {
                    self.send_access_denied(client_id, code, &reason, None);
                    return HandleTextOutcome::None;
                }
                if !self.is_host_client(client_id) {
                    let sender_peer_id = self.client_peer_id(client_id).map(|s| s.to_string());
                    let existing = self
                        .doc
                        .layers
                        .iter()
                        .find(|l| layer_id_of(l) == Some(layer_id.as_str()));
                    if let Some(layer) = existing {
                        let existing_owner = layer.get("ownerPeerId").and_then(value_to_peer_id);
                        let patch = obj.get("patch").and_then(|v| v.as_object());
                        let cleared = obj.get("clearedFields").and_then(|v| v.as_array());
                        let clears_field = |name: &str| {
                            cleared.map_or(false, |arr| {
                                arr.iter().any(|v| v.as_str() == Some(name))
                            })
                        };
                        // Non-host cannot reassign or strip another user's ownership
                        let touches_owner = patch.map_or(false, |p| p.contains_key("ownerPeerId"))
                            || clears_field("ownerPeerId");
                        if touches_owner
                            && existing_owner.is_some()
                            && existing_owner.as_deref() != sender_peer_id.as_deref()
                        {
                            self.send_access_denied(
                                client_id,
                                "NOT_OWNER",
                                "Cannot modify ownership of another user's layer",
                                None,
                            );
                            return HandleTextOutcome::None;
                        }
                        // Non-host can only lock a layer they own (or unowned) and only under their own peerId
                        if let Some(new_lock) = patch
                            .and_then(|p| p.get("reservedByPeerId"))
                            .and_then(value_to_peer_id)
                        {
                            if sender_peer_id.as_deref() != Some(new_lock.as_str()) {
                                self.send_access_denied(
                                    client_id,
                                    "FORBIDDEN",
                                    "Cannot lock layer under another peer ID",
                                    None,
                                );
                                return HandleTextOutcome::None;
                            }
                            if existing_owner.is_some()
                                && existing_owner.as_deref() != sender_peer_id.as_deref()
                            {
                                self.send_access_denied(
                                    client_id,
                                    "NOT_OWNER",
                                    "Only the layer owner or Host can lock this layer",
                                    None,
                                );
                                return HandleTextOutcome::None;
                            }
                        }
                    }
                }
                self.apply_layer_update(&obj);
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "LAYER_TREE_SYNC" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(layers_arr) = obj.get("layers").and_then(|v| v.as_array()) {
                    let sanitized = sanitize_layer_tree_objects(layers_arr);
                    if !sanitized.is_empty() {
                        if !self.is_host_client(client_id) {
                            let sender_peer_id = self.client_peer_id(client_id);
                            let incoming_by_id: HashMap<&str, &serde_json::Map<String, serde_json::Value>> =
                                sanitized
                                    .iter()
                                    .filter_map(|l| layer_id_of(l).map(|id| (id, l)))
                                    .collect();
                            for existing in &self.doc.layers {
                                let Some(eid) = layer_id_of(existing) else {
                                    continue;
                                };
                                let existing_lock =
                                    existing.get("reservedByPeerId").and_then(value_to_peer_id);
                                let existing_owner =
                                    existing.get("ownerPeerId").and_then(value_to_peer_id);
                                match incoming_by_id.get(eid) {
                                    None => {
                                        if existing_lock.is_some()
                                            && existing_lock.as_deref() != sender_peer_id
                                        {
                                            self.send_access_denied(
                                                client_id,
                                                "LAYER_LOCKED",
                                                "Cannot delete a layer locked by another user",
                                                None,
                                            );
                                            return HandleTextOutcome::None;
                                        }
                                        if existing_owner.is_some()
                                            && existing_owner.as_deref() != sender_peer_id
                                        {
                                            self.send_access_denied(
                                                client_id,
                                                "NOT_OWNER",
                                                "Cannot delete another user's layer",
                                                None,
                                            );
                                            return HandleTextOutcome::None;
                                        }
                                    }
                                    Some(next_layer) => {
                                        if existing_lock.is_some()
                                            && existing_lock.as_deref() != sender_peer_id
                                        {
                                            let next_lock = next_layer
                                                .get("reservedByPeerId")
                                                .and_then(value_to_peer_id);
                                            if next_lock != existing_lock {
                                                self.send_access_denied(
                                                    client_id,
                                                    "LAYER_LOCKED",
                                                    "Cannot unlock another user's layer",
                                                    None,
                                                );
                                                return HandleTextOutcome::None;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        self.doc.layers = sanitized;
                        self.prune_orphaned_layer_data();
                    }
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "PERSPECTIVE_RULER_SYNC" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(ruler) = obj.get("perspectiveRuler") {
                    self.doc.perspective_ruler = ruler.clone();
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "STRAIGHT_RULER_SYNC" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(ruler) = obj.get("straightRuler") {
                    self.doc.straight_ruler = ruler.clone();
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "ANIMATION_SYNC" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(tl) = obj.get("animationTimeline") {
                    self.doc.animation_timeline = tl.clone();
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "CANVAS_RESIZE" => {
                if let Err((code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, code, reason, None);
                    return HandleTextOutcome::None;
                }
                if let Some(dims) = obj.get("dimensions").and_then(|v| v.as_object()) {
                    let w = dims.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let h = dims.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    if w.is_finite()
                        && h.is_finite()
                        && w >= 1.0
                        && h >= 1.0
                        && w <= MAX_SYNC_CANVAS_DIM as f64
                        && h <= MAX_SYNC_CANVAS_DIM as f64
                    {
                        self.doc.dimensions = serde_json::Value::Object(dims.clone());
                    }
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            "PEER_LEFT" => {
                self.peers.remove(&client_id);
                if self.host_client_id == Some(client_id) {
                    self.host_client_id = None;
                }
                self.commit_and_broadcast_text(client_id, obj, true);
                HandleTextOutcome::None
            }

            // Ephemeral messages: monotonic seq stamped, broadcast immediately, not logged
            "CURSOR_MOVE" | "CANVAS_PING" => {
                self.commit_and_broadcast_text(client_id, obj, false);
                HandleTextOutcome::None
            }

            // Any other valid JSON protocol message (e.g. JOIN_ACCEPTED, PEER_JOINED fallback)
            _ => {
                self.commit_and_broadcast_text(client_id, obj, false);
                HandleTextOutcome::None
            }
        }
    }

    fn commit_and_broadcast_text(
        &mut self,
        client_id: usize,
        mut obj: serde_json::Map<String, serde_json::Value>,
        record_in_log: bool,
    ) {
        let seq = self.next_seq();
        obj.insert("seq".to_string(), serde_json::Value::from(seq));
        let text = Arc::new(serde_json::Value::Object(obj).to_string());
        if record_in_log {
            self.push_op_log(seq, Some(client_id), OpPayload::Text(Arc::clone(&text)));
        }
        self.broadcast_live(Some(client_id), Message::Text((*text).clone()));
    }

    fn handle_binary_frame(&mut self, client_id: usize, mut bin: Vec<u8>) {
        if bin.len() < BINARY_HEADER_BYTES || bin.len() > MAX_WS_MESSAGE_BYTES {
            return;
        }
        if bin[0] != BINARY_MAGIC_0 || bin[1] != BINARY_MAGIC_1 {
            return;
        }
        let code = bin[2];
        if !(CODE_STROKE_START..=CODE_LAYER_MASK_DATA).contains(&code) {
            return;
        }
        let payload_len = u32::from_le_bytes([bin[7], bin[8], bin[9], bin[10]]) as usize;
        if BINARY_HEADER_BYTES.saturating_add(payload_len) != bin.len() {
            return;
        }

        // Validate structured binary payloads BEFORE allocating seq or mutating state
        enum ParsedBinary {
            Tile {
                key: TileKey,
                is_empty: bool,
            },
            Mask {
                layer_id: String,
                is_full_replace: bool,
            },
            StrokeFinish,
            SelectiveUndo,
            LoggedOther,
            Ephemeral,
        }

        let parsed = match code {
            CODE_TILE_DELTA => {
                let Some((key, _version, is_empty)) =
                    parse_tile_delta_header(&bin[BINARY_HEADER_BYTES..])
                else {
                    return;
                };
                if let Err((denial_code, reason)) = self.can_modify_layer(client_id, &key.layer_id)
                {
                    self.send_access_denied(client_id, denial_code, &reason, None);
                    return;
                }
                ParsedBinary::Tile { key, is_empty }
            }
            CODE_LAYER_MASK_DATA => {
                let Some((layer_id, is_full_replace)) =
                    parse_mask_data_header(&bin[BINARY_HEADER_BYTES..])
                else {
                    return;
                };
                if let Err((denial_code, reason)) = self.can_modify_layer(client_id, &layer_id) {
                    self.send_access_denied(client_id, denial_code, &reason, None);
                    return;
                }
                ParsedBinary::Mask {
                    layer_id,
                    is_full_replace,
                }
            }
            CODE_STROKE_FINISH => {
                if let Err((denial_code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, denial_code, reason, None);
                    return;
                }
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bin[BINARY_HEADER_BYTES..]) {
                    if let Some(lid) = val.get("layerId").and_then(|v| v.as_str()) {
                        if let Err((denial_code, reason)) = self.can_modify_layer(client_id, lid) {
                            self.send_access_denied(client_id, denial_code, &reason, None);
                            return;
                        }
                    }
                }
                ParsedBinary::StrokeFinish
            }
            CODE_SELECTIVE_UNDO => {
                if let Err((denial_code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, denial_code, reason, None);
                    return;
                }
                ParsedBinary::SelectiveUndo
            }
            CODE_STROKE_START => {
                if let Err((denial_code, reason)) = self.can_mutate_canvas(client_id) {
                    self.send_access_denied(client_id, denial_code, reason, None);
                    return;
                }
                if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bin[BINARY_HEADER_BYTES..]) {
                    if let Some(lid) = val.get("layerId").and_then(|v| v.as_str()) {
                        if let Err((denial_code, reason)) = self.can_modify_layer(client_id, lid) {
                            self.send_access_denied(client_id, denial_code, &reason, None);
                            return;
                        }
                    }
                }
                ParsedBinary::LoggedOther
            }
            CODE_STROKE_CHUNK => {
                if self.can_mutate_canvas(client_id).is_err() {
                    return;
                }
                ParsedBinary::Ephemeral
            }
            CODE_BRUSH_ASSET_DATA => {
                if self.can_mutate_canvas(client_id).is_err() {
                    return;
                }
                ParsedBinary::LoggedOther
            }
            CODE_CURSOR_MOVE | CODE_BRUSH_ASSET_REQUEST => ParsedBinary::Ephemeral,
            _ => return,
        };

        // Stamp authoritative server monotonic seq into bytes [3..7]
        let seq = self.next_seq();
        bin[3..7].copy_from_slice(&(seq as u32).to_le_bytes());
        let pkt = Arc::new(bin);

        let record_in_log = match parsed {
            ParsedBinary::Tile { key, is_empty } => {
                if is_empty {
                    if let Some(old) = self.tiles.remove(&key) {
                        self.tile_store_bytes = self.tile_store_bytes.saturating_sub(old.len());
                    }
                } else {
                    let pkt_len = pkt.len();
                    let old_len = self.tiles.get(&key).map_or(0, |t| t.len());
                    let next_bytes = self
                        .tile_store_bytes
                        .saturating_sub(old_len)
                        .saturating_add(pkt_len);
                    let within_count =
                        self.tiles.contains_key(&key) || self.tiles.len() < MAX_STORED_TILES;
                    if within_count && next_bytes <= MAX_TILE_STORE_BYTES {
                        self.tile_store_bytes = next_bytes;
                        self.tiles.insert(key, Arc::clone(&pkt));
                    }
                }
                true
            }
            ParsedBinary::Mask {
                layer_id,
                is_full_replace,
            } => {
                let pkt_len = pkt.len();
                if is_full_replace {
                    self.prune_layer_masks(&layer_id);
                    if self.mask_store_bytes.saturating_add(pkt_len) <= MAX_MASK_STORE_BYTES {
                        self.mask_store_bytes = self.mask_store_bytes.saturating_add(pkt_len);
                        self.masks.insert(layer_id, vec![Arc::clone(&pkt)]);
                    }
                } else {
                    let entry = self.masks.entry(layer_id).or_default();
                    if entry.len() < MAX_MASK_PACKETS_PER_LAYER
                        && self.mask_store_bytes.saturating_add(pkt_len) <= MAX_MASK_STORE_BYTES
                    {
                        self.mask_store_bytes = self.mask_store_bytes.saturating_add(pkt_len);
                        entry.push(Arc::clone(&pkt));
                    }
                }
                true
            }
            ParsedBinary::StrokeFinish => {
                self.apply_vector_stroke_finish(&pkt[BINARY_HEADER_BYTES..]);
                true
            }
            ParsedBinary::SelectiveUndo => {
                self.apply_vector_selective_undo(&pkt[BINARY_HEADER_BYTES..]);
                true
            }
            ParsedBinary::LoggedOther => true,
            ParsedBinary::Ephemeral => false,
        };

        if record_in_log {
            self.push_op_log(seq, Some(client_id), OpPayload::Binary(Arc::clone(&pkt)));
        }
        self.broadcast_live(Some(client_id), Message::Binary((*pkt).clone()));
    }

    fn apply_vector_stroke_finish(&mut self, payload: &[u8]) {
        let Ok(val) = serde_json::from_slice::<serde_json::Value>(payload) else {
            return;
        };
        let Some(vector_stroke) = val.get("vectorStroke").filter(|v| v.is_object()) else {
            return;
        };
        let Some(layer_id) = val.get("layerId").and_then(|v| v.as_str()) else {
            return;
        };
        if let Some(layer) = self
            .doc
            .layers
            .iter_mut()
            .find(|l| layer_id_of(l) == Some(layer_id))
        {
            if layer.get("type").and_then(|v| v.as_str()) == Some("vector") {
                let strokes = layer
                    .entry("vectorStrokes".to_string())
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let Some(arr) = strokes.as_array_mut() {
                    if arr.len() < MAX_SYNC_VECTOR_STROKES {
                        arr.push(vector_stroke.clone());
                    }
                }
            }
        }
    }

    fn apply_vector_selective_undo(&mut self, payload: &[u8]) {
        let Ok(val) = serde_json::from_slice::<serde_json::Value>(payload) else {
            return;
        };
        let Some(stroke_id) = val.get("strokeId").and_then(|v| v.as_str()) else {
            return;
        };
        for layer in &mut self.doc.layers {
            if let Some(arr) = layer
                .get_mut("vectorStrokes")
                .and_then(|v| v.as_array_mut())
            {
                for st in arr.iter_mut() {
                    if st.get("id").and_then(|v| v.as_str()) == Some(stroke_id) {
                        if let Some(obj) = st.as_object_mut() {
                            obj.insert("deleted".to_string(), serde_json::Value::Bool(true));
                        }
                    }
                }
            }
        }
    }

    fn disconnect_client(&mut self, client_id: usize, fallback_peer_id: Option<String>) {
        self.clients.remove(&client_id);
        let removed_peer = self.peers.remove(&client_id);
        if self.host_client_id == Some(client_id) {
            self.host_client_id = None;
        }

        let peer_id = removed_peer.map(|p| p.id).or(fallback_peer_id);
        let seq = self.next_seq();
        let leave_msg = match &peer_id {
            Some(pid) => serde_json::json!({
                "type": "PEER_DISCONNECTED",
                "seq": seq,
                "peerId": pid,
                "clientId": client_id,
            }),
            None => serde_json::json!({
                "type": "PEER_DISCONNECTED",
                "seq": seq,
                "clientId": client_id,
            }),
        };
        let text = Arc::new(leave_msg.to_string());
        if peer_id.is_some() {
            self.push_op_log(seq, None, OpPayload::Text(Arc::clone(&text)));
        }
        self.broadcast_live(None, Message::Text((*text).clone()));
    }
}

struct TokenBucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(capacity: f64, refill_per_sec: f64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_sec,
            last_refill: Instant::now(),
        }
    }

    fn try_consume(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        if elapsed > 0.0 {
            self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            self.last_refill = now;
        }
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub room_name: String,
    pub room_token: Arc<String>,
    pub local_ip: String,
    pub port: u16,
    pub tunnel_origin: Arc<std::sync::RwLock<Option<String>>>,
    room: Arc<std::sync::Mutex<RoomState>>,
    client_slots: Arc<Semaphore>,
    connect_limiter: Arc<std::sync::Mutex<TokenBucket>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: String,
    pub room_name: String,
    pub room_token: String,
    pub invite_url: String,
    pub peer_count: usize,
    pub is_global: bool,
    pub local_invite_url: Option<String>,
}

#[derive(Deserialize)]
struct WsAuthQuery {
    token: Option<String>,
}

pub struct ServerManager {
    shutdown_tx: Option<oneshot::Sender<()>>,
    current_info: Option<ServerInfo>,
    state: Option<AppState>,
    tunnel_child: Option<tokio::process::Child>,
}

impl ServerManager {
    pub fn new() -> Self {
        Self {
            shutdown_tx: None,
            current_info: None,
            state: None,
            tunnel_child: None,
        }
    }
}

pub static SERVER_MANAGER: std::sync::OnceLock<tokio::sync::Mutex<ServerManager>> =
    std::sync::OnceLock::new();

pub fn get_server_manager() -> &'static tokio::sync::Mutex<ServerManager> {
    SERVER_MANAGER.get_or_init(|| tokio::sync::Mutex::new(ServerManager::new()))
}

fn generate_room_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("CSPRNG failure generating room token: {}", e))?;
    Ok(hex::encode(bytes))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_valid_port_suffix(rest: &str) -> bool {
    if rest.is_empty() {
        return true;
    }
    let Some(port_str) = rest.strip_prefix(':') else {
        return false;
    };
    !port_str.is_empty()
        && port_str.len() <= 5
        && port_str.bytes().all(|b| b.is_ascii_digit())
        && port_str.parse::<u16>().is_ok()
}

fn is_private_lan_ipv4(host: &str) -> bool {
    let Ok(ip) = host.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 64) // Tailscale / CGNAT 100.64.0.0/10
}

fn is_allowed_origin(
    origin: &str,
    local_ip: &str,
    port: u16,
    tunnel_origin: Option<&str>,
    host_header: Option<&str>,
) -> bool {
    if origin.is_empty() || origin.eq_ignore_ascii_case("null") {
        return false;
    }
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    if let Some(rest) = origin.strip_prefix("http://localhost") {
        if is_valid_port_suffix(rest) {
            return true;
        }
    }
    if let Some(rest) = origin.strip_prefix("http://127.0.0.1") {
        if is_valid_port_suffix(rest) {
            return true;
        }
    }
    // Allow local private-network Vite dev origins (:1420) for LAN tablet browser testing
    // without opening arbitrary LAN ports (e.g. :9999 remains blocked against CSWSH).
    if let Some(host_and_port) = origin.strip_prefix("http://") {
        if let Some(host_part) = host_and_port.strip_suffix(":1420") {
            if is_private_lan_ipv4(host_part) {
                return true;
            }
        }
    }
    let local_origin_with_port = format!("http://{}:{}", local_ip, port);
    if origin == local_origin_with_port {
        return true;
    }
    if port == 80 && origin == format!("http://{}", local_ip) {
        return true;
    }
    if let Some(tunnel) = tunnel_origin {
        if !tunnel.is_empty() && origin == tunnel.trim_end_matches('/') {
            return true;
        }
    }
    // Same-origin check against Host header (supports multi-NIC LAN / Tailscale IPs
    // while still blocking cross-site WebSocket hijacking from external domains).
    if let Some(host) = host_header {
        let trimmed_host = host.trim();
        if !trimmed_host.is_empty()
            && !trimmed_host.contains('/')
            && !trimmed_host.contains('@')
        {
            if let Some(origin_host) = origin
                .strip_prefix("http://")
                .or_else(|| origin.strip_prefix("https://"))
            {
                if origin_host.eq_ignore_ascii_case(trimmed_host) {
                    return true;
                }
            }
        }
    }
    false
}

/// Tries to discover the local LAN IP address by probing an outbound route
pub fn get_local_ip() -> String {
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(local_addr) = socket.local_addr() {
                let ip = local_addr.ip();
                if !ip.is_loopback() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../dist/"]
struct EmbeddedAssets;

async fn static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }

    match EmbeddedAssets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            (
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                content.data,
            )
                .into_response()
        }
        None => match EmbeddedAssets::get("index.html") {
            Some(content) => (
                [(axum::http::header::CONTENT_TYPE, "text/html")],
                content.data,
            )
                .into_response(),
            None => (axum::http::StatusCode::NOT_FOUND, "404 Not Found").into_response(),
        },
    }
}

fn cloudflared_install_path() -> PathBuf {
    let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(local_appdata)
        .join("InkStudio")
        .join("bin")
        .join("cloudflared.exe")
}

async fn locate_cloudflared() -> Result<PathBuf, String> {
    // 1. Next to current executable or in its bin/
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let next_to_exe = parent.join("cloudflared.exe");
            if next_to_exe.exists() {
                return Ok(next_to_exe);
            }
            let in_bin = parent.join("bin").join("cloudflared.exe");
            if in_bin.exists() {
                return Ok(in_bin);
            }
        }
    }

    // 2. Project development folders
    let dev_bin_1 = PathBuf::from("src-tauri").join("bin").join("cloudflared.exe");
    if dev_bin_1.exists() {
        return Ok(dev_bin_1);
    }
    let dev_bin_2 = PathBuf::from("bin").join("cloudflared.exe");
    if dev_bin_2.exists() {
        return Ok(dev_bin_2);
    }

    // 3. AppData / LocalAppData
    let target_path = cloudflared_install_path();
    if target_path.exists() {
        return Ok(target_path);
    }

    // 4. In system PATH
    let mut check_path = tokio::process::Command::new("cloudflared");
    check_path.arg("--version");
    #[cfg(windows)]
    check_path.creation_flags(CREATE_NO_WINDOW);
    if let Ok(output) = check_path.output().await {
        if output.status.success() {
            return Ok(PathBuf::from("cloudflared"));
        }
    }

    Err(format!(
        "cloudflared is not installed. Install cloudflared manually or invoke download_cloudflared (pinned v{} with SHA-256 verification).",
        PINNED_CLOUDFLARED_VERSION
    ))
}

fn verify_sha256_bytes(bytes: &[u8], expected_hex: &str) -> Result<String, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual_hex = hex::encode(hasher.finalize());
    let expected_lower = expected_hex.trim().to_ascii_lowercase();
    if constant_time_eq(actual_hex.as_bytes(), expected_lower.as_bytes()) {
        Ok(actual_hex)
    } else {
        Err(format!(
            "SHA-256 verification failed (expected {}, got {})",
            expected_lower, actual_hex
        ))
    }
}

/// Explicit user-initiated download of pinned cloudflared binary with mandatory SHA-256 verification.
pub async fn download_cloudflared() -> Result<String, String> {
    let target_path = cloudflared_install_path();
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create bin directory: {}", e))?;
    }

    let tmp_path = target_path.with_extension("exe.tmp");
    let _ = tokio::fs::remove_file(&tmp_path).await;

    let mut download_proc = tokio::process::Command::new("curl.exe");
    download_proc.args([
        "--proto",
        "=https",
        "--tlsv1.2",
        "-f",
        "-L",
        "-s",
        "--max-filesize",
        &MAX_CLOUDFLARED_BYTES.to_string(),
        PINNED_CLOUDFLARED_URL,
        "-o",
    ]);
    download_proc.arg(&tmp_path);
    #[cfg(windows)]
    download_proc.creation_flags(CREATE_NO_WINDOW);

    let status = download_proc
        .status()
        .await
        .map_err(|e| format!("Failed to execute curl.exe: {}", e))?;

    if !status.success() || !tmp_path.exists() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!(
            "Failed to download cloudflared v{}",
            PINNED_CLOUDFLARED_VERSION
        ));
    }

    let meta = tokio::fs::symlink_metadata(&tmp_path)
        .await
        .map_err(|e| format!("Failed to stat downloaded binary: {}", e))?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_CLOUDFLARED_BYTES {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err("Downloaded cloudflared artifact failed safety checks".to_string());
    }

    let bytes = tokio::fs::read(&tmp_path)
        .await
        .map_err(|e| format!("Failed to read downloaded binary: {}", e))?;

    if let Err(err) = verify_sha256_bytes(&bytes, PINNED_CLOUDFLARED_SHA256) {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(err);
    }

    if tokio::fs::rename(&tmp_path, &target_path).await.is_err() {
        let _ = tokio::fs::remove_file(&target_path).await;
        if let Err(e) = tokio::fs::rename(&tmp_path, &target_path).await {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(format!("Failed to install verified cloudflared binary: {}", e));
        }
    }

    Ok(target_path.to_string_lossy().to_string())
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    if let Some(start_idx) = line.find("https://") {
        let remainder = &line[start_idx..];
        let end_idx = remainder
            .find(|c: char| c.is_whitespace() || c == '|' || c == '+' || c == '\r' || c == '\n')
            .unwrap_or(remainder.len());
        let candidate = remainder[..end_idx].trim().trim_end_matches('/');
        if let Some(host) = candidate.strip_prefix("https://") {
            if host.ends_with(".trycloudflare.com")
                && !host.contains('/')
                && !host.contains('@')
                && !host.contains('?')
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

pub async fn is_cloudflared_installed() -> bool {
    locate_cloudflared().await.is_ok()
}

async fn ensure_cloudflared() -> Result<PathBuf, String> {
    if let Ok(path) = locate_cloudflared().await {
        return Ok(path);
    }
    let installed = download_cloudflared().await?;
    Ok(PathBuf::from(installed))
}

async fn start_cloudflare_tunnel(port: u16) -> Result<(tokio::process::Child, String), String> {
    let exe_path = ensure_cloudflared().await?;
    let mut cmd = tokio::process::Command::new(exe_path);
    cmd.args([
        "tunnel",
        "--url",
        &format!("http://127.0.0.1:{}", port),
        "--protocol",
        "http2",
        "--no-autoupdate",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start cloudflared: {}", e))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture cloudflared stderr".to_string())?;

    let mut reader = BufReader::new(stderr).lines();
    let mut found_url: Option<String> = None;
    let mut last_error_line: Option<String> = None;

    let overall_deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(30);
    let mut post_url_deadline: Option<tokio::time::Instant> = None;

    loop {
        let active_deadline = match post_url_deadline {
            Some(d) => d.min(overall_deadline),
            None => overall_deadline,
        };

        let next = tokio::select! {
            line = reader.next_line() => Some(line),
            _ = tokio::time::sleep_until(active_deadline) => None,
        };

        match next {
            Some(Ok(Some(line))) => {
                if found_url.is_none() {
                    if let Some(url) = extract_trycloudflare_url(&line) {
                        found_url = Some(url);
                        // Wait briefly for Cloudflare edge registration so the link works immediately
                        post_url_deadline =
                            Some(tokio::time::Instant::now() + tokio::time::Duration::from_secs(8));
                    }
                }
                let lower = line.to_ascii_lowercase();
                if lower.contains("err") || lower.contains("failed") || lower.contains("unable") {
                    last_error_line = Some(line.trim().chars().take(180).collect());
                }
                if found_url.is_some()
                    && (line.contains("Registered tunnel connection")
                        || lower.contains("connection registered"))
                {
                    break;
                }
            }
            Some(Ok(None)) | Some(Err(_)) => {
                // Process closed stderr / exited
                break;
            }
            None => {
                // Deadline reached
                break;
            }
        }
    }

    match found_url {
        Some(url) => {
            // Confirm process is still alive
            if let Ok(Some(exit_status)) = child.try_wait() {
                let detail = last_error_line
                    .map(|l| format!(" ({})", l))
                    .unwrap_or_default();
                return Err(format!(
                    "Cloudflare tunnel exited unexpectedly ({}){}",
                    exit_status, detail
                ));
            }
            // Keep draining stderr in the background so cloudflared never receives EPIPE
            tokio::spawn(async move {
                while let Ok(Some(_)) = reader.next_line().await {}
            });
            Ok((child, url))
        }
        None => {
            let _ = child.kill().await;
            let detail = last_error_line
                .map(|l| format!(": {}", l))
                .unwrap_or_default();
            Err(format!(
                "Could not establish Cloudflare tunnel URL{}",
                detail
            ))
        }
    }
}

fn build_router(state: AppState) -> Router {
    let cors_local_ip = state.local_ip.clone();
    let cors_port = state.port;
    let cors_tunnel_origin = Arc::clone(&state.tunnel_origin);

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, req| {
            let Ok(origin_str) = origin.to_str() else {
                return false;
            };
            let host_str = req.headers.get(header::HOST).and_then(|v| v.to_str().ok());
            let tunnel = cors_tunnel_origin.read().ok().and_then(|g| g.clone());
            is_allowed_origin(
                origin_str,
                &cors_local_ip,
                cors_port,
                tunnel.as_deref(),
                host_str,
            )
        }))
        .allow_methods([Method::GET, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
        .fallback(static_handler)
        .layer(cors)
}

pub async fn start_embedded_server(
    port: u16,
    room_name: String,
    enable_tunnel: bool,
) -> Result<ServerInfo, String> {
    let mut manager = get_server_manager().lock().await;

    // If a server is already running, shut it down first
    if let Some(tx) = manager.shutdown_tx.take() {
        let _ = tx.send(());
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
    if let Some(mut child) = manager.tunnel_child.take() {
        let _ = child.kill().await;
    }

    let room_token = generate_room_token()?;
    let local_ip = get_local_ip();
    let encoded_room = urlencoding_encode(&room_name);
    let local_invite_url = format!(
        "http://{}:{}/?room={}&token={}",
        local_ip, port, encoded_room, room_token
    );

    let mut invite_url = local_invite_url.clone();
    let mut tunnel_child = None;
    let mut is_global = false;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let tunnel_origin = Arc::new(std::sync::RwLock::new(None));
    let app_state = AppState {
        room_name: room_name.clone(),
        room_token: Arc::new(room_token.clone()),
        local_ip: local_ip.clone(),
        port,
        tunnel_origin: Arc::clone(&tunnel_origin),
        room: Arc::new(std::sync::Mutex::new(RoomState::new(room_name.clone()))),
        client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
        connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
            CONNECT_BURST,
            CONNECT_REFILL_PER_SEC,
        ))),
    };

    let router = build_router(app_state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    if enable_tunnel {
        match start_cloudflare_tunnel(port).await {
            Ok((child, tunnel_base_url)) => {
                if let Ok(mut guard) = tunnel_origin.write() {
                    *guard = Some(tunnel_base_url.clone());
                }
                invite_url = format!(
                    "{}/?room={}&token={}",
                    tunnel_base_url, encoded_room, room_token
                );
                tunnel_child = Some(child);
                is_global = true;
            }
            Err(err) => {
                // Do not silently fall back to an unreachable private LAN IP when Worldwide was requested.
                let _ = shutdown_tx.send(());
                return Err(format!("Worldwide tunnel failed: {}", err));
            }
        }
    }

    let info = ServerInfo {
        is_running: true,
        port,
        local_ip,
        room_name,
        room_token,
        invite_url,
        peer_count: 0,
        is_global,
        local_invite_url: Some(local_invite_url),
    };

    manager.shutdown_tx = Some(shutdown_tx);
    manager.tunnel_child = tunnel_child;
    manager.current_info = Some(info.clone());
    manager.state = Some(app_state);

    Ok(info)
}

pub async fn stop_embedded_server() -> Result<(), String> {
    let mut manager = get_server_manager().lock().await;
    if let Some(tx) = manager.shutdown_tx.take() {
        let _ = tx.send(());
    }
    if let Some(mut child) = manager.tunnel_child.take() {
        let _ = child.kill().await;
    }
    manager.current_info = None;
    manager.state = None;
    manager.tunnel_child = None;
    Ok(())
}

/// Synchronous teardown hook for `RunEvent::Exit` to guarantee `cloudflared` termination.
pub fn shutdown_sync() {
    let Some(manager_lock) = SERVER_MANAGER.get() else {
        return;
    };

    if let Ok(mut manager) = manager_lock.try_lock() {
        if let Some(tx) = manager.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut child) = manager.tunnel_child.take() {
            let _ = child.start_kill();
            let _ = child.try_wait();
        }
        manager.current_info = None;
        manager.state = None;
        return;
    }

    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(
            tokio::time::Duration::from_secs(2),
            stop_embedded_server(),
        )
        .await;
    });
}

pub async fn get_server_status() -> ServerInfo {
    let manager = get_server_manager().lock().await;
    if let (Some(info), Some(state)) = (&manager.current_info, &manager.state) {
        let count = state.room.lock().map(|r| r.clients.len()).unwrap_or(0);
        let mut updated = info.clone();
        updated.peer_count = count;
        updated
    } else {
        ServerInfo {
            is_running: false,
            port: 30303,
            local_ip: get_local_ip(),
            room_name: String::new(),
            room_token: String::new(),
            invite_url: String::new(),
            peer_count: 0,
            is_global: false,
            local_invite_url: None,
        }
    }
}

fn extract_auth_token<'a>(query: &'a WsAuthQuery, headers: &'a HeaderMap) -> Option<&'a str> {
    if let Some(token) = query.token.as_deref() {
        if !token.is_empty() {
            return Some(token);
        }
    }
    if let Some(auth_val) = headers.get(header::AUTHORIZATION) {
        if let Ok(auth_str) = auth_val.to_str() {
            if let Some(bearer) = auth_str.strip_prefix("Bearer ") {
                if !bearer.is_empty() {
                    return Some(bearer);
                }
            }
        }
    }
    None
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsAuthQuery>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // 1. Connection-attempt rate limiting
    {
        let allowed = state
            .connect_limiter
            .lock()
            .map(|mut limiter| limiter.try_consume(1.0))
            .unwrap_or(false);
        if !allowed {
            return (StatusCode::TOO_MANY_REQUESTS, "Too many connection attempts").into_response();
        }
    }

    // 2. Origin check when Origin header is present (prevents cross-site WebSocket hijacking)
    if let Some(origin_val) = headers.get(header::ORIGIN) {
        let host_str = headers.get(header::HOST).and_then(|v| v.to_str().ok());
        let origin_allowed = origin_val.to_str().ok().map_or(false, |origin_str| {
            let tunnel = state.tunnel_origin.read().ok().and_then(|g| g.clone());
            is_allowed_origin(
                origin_str,
                &state.local_ip,
                state.port,
                tunnel.as_deref(),
                host_str,
            )
        });
        if !origin_allowed {
            return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
        }
    }

    // 3. Constant-time room token verification
    let provided = extract_auth_token(&query, &headers);
    let token_valid = provided.map_or(false, |tok| {
        constant_time_eq(tok.as_bytes(), state.room_token.as_bytes())
    });
    if !token_valid {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }

    // 4. Enforce strict concurrent client ceiling atomically before upgrade
    let Ok(permit) = Arc::clone(&state.client_slots).try_acquire_owned() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Room is full").into_response();
    };

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, permit))
}

#[inline]
fn is_forbidden_json_key(k: &str) -> bool {
    k == "__proto__" || k == "constructor" || k == "prototype"
}

#[inline]
fn is_background_layer_id(id: &str) -> bool {
    id == "layer-bg" || id.starts_with("layer-bg")
}

#[inline]
fn layer_id_of(layer: &serde_json::Map<String, serde_json::Value>) -> Option<&str> {
    layer.get("id").and_then(|v| v.as_str())
}

fn value_to_peer_id(val: &serde_json::Value) -> Option<String> {
    let s = match val {
        serde_json::Value::String(s) => s.trim().to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if s.is_empty() || s.len() > 128 {
        return None;
    }
    Some(s)
}

fn parse_peer_from_join(
    obj: &serde_json::Map<String, serde_json::Value>,
    client_id: usize,
) -> Option<PeerRecord> {
    let peer_obj = obj.get("peer")?.as_object()?;
    let id = value_to_peer_id(peer_obj.get("id")?)?;
    let name: String = peer_obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Guest")
        .trim()
        .chars()
        .take(64)
        .collect();
    let name = if name.is_empty() {
        "Guest".to_string()
    } else {
        name
    };
    let color: String = peer_obj
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#38bdf8")
        .trim()
        .chars()
        .take(32)
        .collect();
    let is_host = peer_obj
        .get("isHost")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut raw = serde_json::Map::new();
    raw.insert("id".to_string(), serde_json::Value::String(id.clone()));
    raw.insert("name".to_string(), serde_json::Value::String(name.clone()));
    raw.insert(
        "color".to_string(),
        serde_json::Value::String(if color.is_empty() {
            "#38bdf8".to_string()
        } else {
            color.clone()
        }),
    );
    raw.insert("isHost".to_string(), serde_json::Value::Bool(is_host));
    let initial_role = if is_host {
        PeerRole::Host
    } else {
        PeerRole::Editor
    };
    raw.insert(
        "role".to_string(),
        serde_json::Value::String(initial_role.as_str().to_string()),
    );

    Some(PeerRecord {
        client_id,
        id,
        name,
        is_host,
        role: initial_role,
        raw,
    })
}

fn sanitize_layer_object(
    raw: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let id = raw.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > 256 {
        return None;
    }
    let mut out = serde_json::Map::with_capacity(raw.len());
    for (k, v) in raw {
        if is_forbidden_json_key(k) {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    out.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    Some(out)
}

fn sanitize_layer_tree_objects(
    raw_layers: &[serde_json::Value],
) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let mut out: Vec<serde_json::Map<String, serde_json::Value>> =
        Vec::with_capacity(raw_layers.len().min(MAX_SYNC_LAYERS));
    let mut seen: HashSet<String> = HashSet::new();

    for val in raw_layers.iter().take(MAX_SYNC_LAYERS) {
        let Some(obj) = val.as_object() else {
            continue;
        };
        let Some(clean) = sanitize_layer_object(obj) else {
            continue;
        };
        let id = layer_id_of(&clean).unwrap_or("").to_string();
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        out.push(clean);
    }

    // Break dangling parentId references and cycles
    let id_to_parent: HashMap<String, Option<String>> = out
        .iter()
        .filter_map(|l| {
            let id = layer_id_of(l)?.to_string();
            let pid = l
                .get("parentId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            Some((id, pid))
        })
        .collect();

    for layer in &mut out {
        let Some(id) = layer_id_of(layer).map(|s| s.to_string()) else {
            continue;
        };
        let Some(mut cur_parent) = layer
            .get("parentId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
        else {
            continue;
        };
        if !id_to_parent.contains_key(&cur_parent) {
            layer.insert("parentId".to_string(), serde_json::Value::Null);
            continue;
        }
        let mut visited: HashSet<String> = HashSet::new();
        visited.insert(id);
        loop {
            if !visited.insert(cur_parent.clone()) {
                layer.insert("parentId".to_string(), serde_json::Value::Null);
                break;
            }
            match id_to_parent.get(&cur_parent).and_then(|p| p.as_ref()) {
                Some(next_parent) => cur_parent = next_parent.clone(),
                None => break,
            }
        }
    }

    out
}

fn next_collab_layer_name(
    username: &str,
    layers: &[serde_json::Map<String, serde_json::Value>],
) -> String {
    let clean = username.trim();
    let base = if clean.is_empty() { "User" } else { clean };
    let base_lower = base.to_lowercase();
    let mut max_num: u32 = 0;

    for l in layers {
        let Some(name) = l.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let lower = name.to_lowercase();
        if let Some(rest) = lower.strip_prefix(&base_lower) {
            let trimmed = rest.trim();
            if trimmed.is_empty() {
                max_num = max_num.max(1);
            } else if trimmed.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(n) = trimmed.parse::<u32>() {
                    max_num = max_num.max(n);
                }
            }
        }
    }

    format!("{} {}", base, max_num.saturating_add(1))
}

fn parse_tile_delta_header(payload: &[u8]) -> Option<(TileKey, u32, bool)> {
    if payload.len() < 2 {
        return None;
    }
    let layer_id_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    if layer_id_len == 0
        || layer_id_len > 256
        || 2 + layer_id_len + TILE_PACKET_HEADER_BYTES > payload.len()
    {
        return None;
    }
    let layer_id = std::str::from_utf8(&payload[2..2 + layer_id_len]).ok()?;
    let hdr = &payload[2 + layer_id_len..];
    let tile_x = i32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]);
    let tile_y = i32::from_le_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
    let format_code = hdr[8];
    let version = u32::from_le_bytes([hdr[9], hdr[10], hdr[11], hdr[12]]);
    let codec = hdr[13];

    if !(0..MAX_TILE_COORD).contains(&tile_x) || !(0..MAX_TILE_COORD).contains(&tile_y) {
        return None;
    }
    if !matches!(format_code, 1 | 2 | 4) {
        return None;
    }
    if !matches!(codec, TILE_CODEC_EMPTY | TILE_CODEC_RAW | TILE_CODEC_LZ4) {
        return None;
    }
    let body_len = hdr.len() - TILE_PACKET_HEADER_BYTES;
    if codec == TILE_CODEC_EMPTY && body_len != 0 {
        return None;
    }

    Some((
        TileKey {
            layer_id: layer_id.to_string(),
            tile_x,
            tile_y,
        },
        version,
        codec == TILE_CODEC_EMPTY,
    ))
}

fn parse_mask_data_header(payload: &[u8]) -> Option<(String, bool)> {
    if payload.len() < 19 {
        return None;
    }
    let layer_id_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    if layer_id_len == 0 || layer_id_len > 256 || 2 + layer_id_len + 17 > payload.len() {
        return None;
    }
    let layer_id = std::str::from_utf8(&payload[2..2 + layer_id_len]).ok()?;
    let hdr = &payload[2 + layer_id_len..];
    let flags = hdr[0];
    let x = u32::from_le_bytes([hdr[1], hdr[2], hdr[3], hdr[4]]);
    let y = u32::from_le_bytes([hdr[5], hdr[6], hdr[7], hdr[8]]);
    let width = u32::from_le_bytes([hdr[9], hdr[10], hdr[11], hdr[12]]);
    let height = u32::from_le_bytes([hdr[13], hdr[14], hdr[15], hdr[16]]);

    if x > MAX_SYNC_CANVAS_DIM
        || y > MAX_SYNC_CANVAS_DIM
        || width == 0
        || height == 0
        || width > MAX_SYNC_CANVAS_DIM
        || height > MAX_SYNC_CANVAS_DIM
    {
        return None;
    }

    Some((layer_id.to_string(), (flags & MASK_FLAG_FULL_REPLACE) != 0))
}

#[cfg(test)]
fn extract_peer_id_from_join(text: &str) -> Option<String> {
    if !text.contains("JOIN_REQUEST") {
        return None;
    }
    let val: serde_json::Value = serde_json::from_str(text).ok()?;
    let obj = val.as_object()?;
    if obj.get("type")?.as_str()? != "JOIN_REQUEST" {
        return None;
    }
    value_to_peer_id(obj.get("peer")?.get("id")?)
}

async fn run_client_sync_task(
    state: AppState,
    client_id: usize,
    tx: mpsc::Sender<Message>,
    plan: SyncPlan,
) {
    let mut cursor_seq = match plan {
        SyncPlan::Full(snap) => {
            if let Some(join_acc) = snap.join_accepted {
                if tx.send(Message::Text(join_acc)).await.is_err() {
                    return;
                }
            }
            if tx.send(Message::Text(snap.doc_sync_response)).await.is_err() {
                return;
            }
            for tile_pkt in snap.tiles {
                if tx.send(Message::Binary((*tile_pkt).clone())).await.is_err() {
                    return;
                }
            }
            for mask_pkt in snap.masks {
                if tx.send(Message::Binary((*mask_pkt).clone())).await.is_err() {
                    return;
                }
            }
            snap.snapshot_seq
        }
        SyncPlan::Incremental {
            join_accepted,
            since_seq,
        } => {
            if let Some(join_acc) = join_accepted {
                if tx.send(Message::Text(join_acc)).await.is_err() {
                    return;
                }
            }
            since_seq
        }
    };

    // Tail catch-up loop: drain op_log entries > cursor_seq until caught up, then flip to live atomically
    loop {
        enum CatchUpStep {
            Done,
            Evicted,
            SendBatch(Vec<Message>),
        }

        let step = {
            let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
            if !room.clients.contains_key(&client_id) {
                return;
            }
            if cursor_seq < room.op_log_floor {
                if let Some(removed) = room.clients.remove(&client_id) {
                    removed.kick.notify_one();
                }
                CatchUpStep::Evicted
            } else {
                let pending: Vec<(u64, Message)> = room
                    .op_log
                    .iter()
                    .filter(|e| e.seq > cursor_seq && e.sender_client_id != Some(client_id))
                    .map(|e| (e.seq, e.payload.to_message()))
                    .collect();

                if pending.is_empty() {
                    if let Some(c) = room.clients.get_mut(&client_id) {
                        c.live = true;
                        c.sync_in_progress = false;
                    }
                    CatchUpStep::Done
                } else if pending.len() <= 64 {
                    let mut all_enqueued = true;
                    if let Some(c) = room.clients.get_mut(&client_id) {
                        for (s, msg) in pending {
                            if c.tx.try_send(msg).is_err() {
                                all_enqueued = false;
                                break;
                            }
                            cursor_seq = s;
                        }
                        if all_enqueued {
                            c.live = true;
                            c.sync_in_progress = false;
                        }
                    }
                    if all_enqueued {
                        CatchUpStep::Done
                    } else {
                        let after = cursor_seq;
                        let batch: Vec<Message> = room
                            .op_log
                            .iter()
                            .filter(|e| e.seq > after && e.sender_client_id != Some(client_id))
                            .map(|e| {
                                cursor_seq = e.seq;
                                e.payload.to_message()
                            })
                            .collect();
                        CatchUpStep::SendBatch(batch)
                    }
                } else {
                    let batch: Vec<Message> = pending
                        .into_iter()
                        .map(|(s, m)| {
                            cursor_seq = s;
                            m
                        })
                        .collect();
                    CatchUpStep::SendBatch(batch)
                }
            }
        };

        match step {
            CatchUpStep::Done | CatchUpStep::Evicted => break,
            CatchUpStep::SendBatch(batch) => {
                for msg in batch {
                    if tx.send(msg).await.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

async fn handle_socket(socket: WebSocket, state: AppState, _permit: OwnedSemaphorePermit) {
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();

    let (tx, mut rx) = mpsc::channel::<Message>(CLIENT_CHANNEL_CAPACITY);
    let kick = Arc::new(Notify::new());

    // Register client and read current server sequence atomically
    let current_seq = {
        let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
        room.clients.insert(
            client_id,
            ClientHandle {
                tx: tx.clone(),
                kick: Arc::clone(&kick),
                live: true,
                sync_in_progress: false,
            },
        );
        room.seq
    };

    // Spawn task to forward internal bounded channel messages to WebSocket sender
    let forward_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Notify client of room assignment and current authoritative sequence
    let welcome_msg = serde_json::json!({
        "type": "ROOM_INFO",
        "clientId": client_id,
        "roomName": state.room_name,
        "serverSeq": current_seq,
    });
    if tx.try_send(Message::Text(welcome_msg.to_string())).is_err() {
        let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
        room.clients.remove(&client_id);
        forward_task.abort();
        return;
    }

    let mut msg_limiter = TokenBucket::new(CLIENT_MSG_BURST, CLIENT_MSG_REFILL_PER_SEC);
    let mut byte_limiter = TokenBucket::new(CLIENT_BYTES_BURST, CLIENT_BYTES_REFILL_PER_SEC);
    let mut known_peer_id: Option<String> = None;

    // Periodic WebSocket Ping keeps Cloudflare Quick Tunnels alive past the 100s idle cutoff
    let mut ping_interval =
        tokio::time::interval(tokio::time::Duration::from_secs(WS_PING_INTERVAL_SECS));
    ping_interval.tick().await;

    loop {
        tokio::select! {
            _ = kick.notified() => break,
            _ = ping_interval.tick() => {
                if tx.try_send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
            item = receiver.next() => {
                let Some(Ok(msg)) = item else {
                    break;
                };

                match msg {
                    Message::Text(text) => {
                        let len = text.len();
                        if len > MAX_WS_MESSAGE_BYTES
                            || !msg_limiter.try_consume(1.0)
                            || !byte_limiter.try_consume(len as f64)
                        {
                            break;
                        }
                        // Parse outside the room lock to minimize contention
                        let Ok(serde_json::Value::Object(obj)) = serde_json::from_str(&text) else {
                            continue;
                        };
                        let outcome = {
                            let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
                            room.handle_text_object(client_id, obj)
                        };
                        match outcome {
                            HandleTextOutcome::None => {}
                            HandleTextOutcome::PeerRegistered(pid) => {
                                if known_peer_id.is_none() {
                                    known_peer_id = Some(pid);
                                }
                            }
                            HandleTextOutcome::StartSync { peer_id, plan } => {
                                if known_peer_id.is_none() {
                                    if let Some(pid) = peer_id {
                                        known_peer_id = Some(pid);
                                    }
                                }
                                let sync_state = state.clone();
                                let sync_tx = tx.clone();
                                tokio::spawn(async move {
                                    run_client_sync_task(sync_state, client_id, sync_tx, plan).await;
                                });
                            }
                        }
                    }
                    Message::Binary(bin) => {
                        let len = bin.len();
                        if len > MAX_WS_MESSAGE_BYTES
                            || !msg_limiter.try_consume(1.0)
                            || !byte_limiter.try_consume(len as f64)
                        {
                            break;
                        }
                        let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
                        room.handle_binary_frame(client_id, bin);
                    }
                    Message::Ping(payload) => {
                        let _ = tx.try_send(Message::Pong(payload));
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }
        }
    }

    // Client disconnected or evicted: remove from room, emit sequenced PEER_DISCONNECTED
    forward_task.abort();
    {
        let mut room = state.room.lock().unwrap_or_else(|e| e.into_inner());
        room.disconnect_client(client_id, known_peer_id);
    }
}

fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn test_room_token_generation() {
        let t1 = generate_room_token().expect("token1");
        let t2 = generate_room_token().expect("token2");
        assert_eq!(t1.len(), 64);
        assert_eq!(t2.len(), 64);
        assert_ne!(t1, t2);
        assert!(t1.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"secret-token", b"secret-token"));
        assert!(!constant_time_eq(b"secret-token", b"secret-tokeN"));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn test_origin_allowlist() {
        let tunnel = Some("https://calm-brush.trycloudflare.com");
        assert!(is_allowed_origin("tauri://localhost", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("http://tauri.localhost", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("https://tauri.localhost", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("http://localhost:1420", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("http://localhost", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("http://127.0.0.1:30303", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("http://192.168.1.5:30303", "192.168.1.5", 30303, tunnel, None));
        assert!(is_allowed_origin("https://calm-brush.trycloudflare.com", "192.168.1.5", 30303, tunnel, None));
        // Same-origin Host match (e.g. Tailscale / secondary LAN NIC)
        assert!(is_allowed_origin(
            "http://100.64.0.9:30303",
            "192.168.1.5",
            30303,
            tunnel,
            Some("100.64.0.9:30303")
        ));

        // Disallowed origins
        assert!(!is_allowed_origin("https://evil.com", "192.168.1.5", 30303, tunnel, Some("192.168.1.5:30303")));
        assert!(!is_allowed_origin("http://localhost.evil.com", "192.168.1.5", 30303, tunnel, None));
        assert!(!is_allowed_origin("http://localhost:1420/path", "192.168.1.5", 30303, tunnel, None));
        assert!(!is_allowed_origin("http://192.168.1.5:9999", "192.168.1.5", 30303, tunnel, Some("192.168.1.5:30303")));
        assert!(!is_allowed_origin("https://other.trycloudflare.com", "192.168.1.5", 30303, tunnel, Some("calm-brush.trycloudflare.com")));
        assert!(!is_allowed_origin("null", "192.168.1.5", 30303, tunnel, None));
    }

    #[test]
    fn test_extract_peer_id_from_join() {
        let msg = r##"{"type":"JOIN_REQUEST","peer":{"id":"peer-123-abc","name":"Alex","color":"#fff"}}"##;
        assert_eq!(extract_peer_id_from_join(msg), Some("peer-123-abc".to_string()));
        assert_eq!(extract_peer_id_from_join(r#"{"type":"CURSOR_MOVE","peerId":"x"}"#), None);
        assert_eq!(extract_peer_id_from_join("not json"), None);
    }

    #[test]
    fn test_sha256_verification() {
        let digest = verify_sha256_bytes(
            b"abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        assert!(digest.is_ok());

        let bad = verify_sha256_bytes(
            b"abc",
            "0000000000000000000000000000000000000000000000000000000000000000",
        );
        assert!(bad.is_err());
    }

    #[test]
    fn test_token_bucket_rate_limit() {
        let mut bucket = TokenBucket::new(2.0, 0.0);
        assert!(bucket.try_consume(1.0));
        assert!(bucket.try_consume(1.0));
        assert!(!bucket.try_consume(1.0));
    }

    #[tokio::test]
    async fn test_ws_rejects_missing_or_invalid_token_with_401() {
        let state = AppState {
            room_name: "Test".to_string(),
            room_token: Arc::new("expected_secret_token".to_string()),
            local_ip: "127.0.0.1".to_string(),
            port: 0,
            tunnel_origin: Arc::new(std::sync::RwLock::new(None)),
            room: Arc::new(std::sync::Mutex::new(RoomState::new("Test".to_string()))),
            client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
            connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
                CONNECT_BURST,
                CONNECT_REFILL_PER_SEC,
            ))),
        };
        let router = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        // Request without token -> 401
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "GET /ws HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = vec![0u8; 256];
        let n = stream.read(&mut resp).await.unwrap();
        let resp_str = String::from_utf8_lossy(&resp[..n]);
        assert!(
            resp_str.starts_with("HTTP/1.1 401"),
            "expected 401, got: {}",
            resp_str
        );

        // Request with wrong token -> 401
        let mut stream2 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req2 = format!(
            "GET /ws?token=wrong HTTP/1.1\r\nHost: {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream2.write_all(req2.as_bytes()).await.unwrap();
        let n2 = stream2.read(&mut resp).await.unwrap();
        let resp_str2 = String::from_utf8_lossy(&resp[..n2]);
        assert!(
            resp_str2.starts_with("HTTP/1.1 401"),
            "expected 401, got: {}",
            resp_str2
        );

        // Request with valid token -> 101 Switching Protocols
        let mut stream3 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req3 = format!(
            "GET /ws?token=expected_secret_token HTTP/1.1\r\nHost: {}\r\nOrigin: http://localhost:1420\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream3.write_all(req3.as_bytes()).await.unwrap();
        let n3 = stream3.read(&mut resp).await.unwrap();
        let resp_str3 = String::from_utf8_lossy(&resp[..n3]);
        assert!(
            resp_str3.starts_with("HTTP/1.1 101"),
            "expected 101, got: {}",
            resp_str3
        );

        // Request with disallowed Origin -> 403
        let mut stream4 = tokio::net::TcpStream::connect(addr).await.unwrap();
        let req4 = format!(
            "GET /ws?token=expected_secret_token HTTP/1.1\r\nHost: {}\r\nOrigin: https://evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            addr
        );
        stream4.write_all(req4.as_bytes()).await.unwrap();
        let n4 = stream4.read(&mut resp).await.unwrap();
        let resp_str4 = String::from_utf8_lossy(&resp[..n4]);
        assert!(
            resp_str4.starts_with("HTTP/1.1 403"),
            "expected 403, got: {}",
            resp_str4
        );

        server_task.abort();
    }

    fn make_tile_packet(
        layer_id: &str,
        tile_x: i32,
        tile_y: i32,
        version: u32,
        codec: u8,
        tile_body: &[u8],
    ) -> Vec<u8> {
        let lid = layer_id.as_bytes();
        let payload_len = 2 + lid.len() + TILE_PACKET_HEADER_BYTES + tile_body.len();
        let mut pkt = Vec::with_capacity(BINARY_HEADER_BYTES + payload_len);
        pkt.push(BINARY_MAGIC_0);
        pkt.push(BINARY_MAGIC_1);
        pkt.push(CODE_TILE_DELTA);
        pkt.extend_from_slice(&999u32.to_le_bytes()); // spoofed client lamport/seq
        pkt.extend_from_slice(&(payload_len as u32).to_le_bytes());
        pkt.extend_from_slice(&(lid.len() as u16).to_le_bytes());
        pkt.extend_from_slice(lid);
        pkt.extend_from_slice(&tile_x.to_le_bytes());
        pkt.extend_from_slice(&tile_y.to_le_bytes());
        pkt.push(4); // color-32bit
        pkt.extend_from_slice(&version.to_le_bytes());
        pkt.push(codec);
        pkt.extend_from_slice(tile_body);
        pkt
    }

    fn make_mask_packet(layer_id: &str, flags: u8, w: u32, h: u32, body: &[u8]) -> Vec<u8> {
        let lid = layer_id.as_bytes();
        let payload_len = 2 + lid.len() + 17 + body.len();
        let mut pkt = Vec::with_capacity(BINARY_HEADER_BYTES + payload_len);
        pkt.push(BINARY_MAGIC_0);
        pkt.push(BINARY_MAGIC_1);
        pkt.push(CODE_LAYER_MASK_DATA);
        pkt.extend_from_slice(&1u32.to_le_bytes());
        pkt.extend_from_slice(&(payload_len as u32).to_le_bytes());
        pkt.extend_from_slice(&(lid.len() as u16).to_le_bytes());
        pkt.extend_from_slice(lid);
        pkt.push(flags);
        pkt.extend_from_slice(&0u32.to_le_bytes()); // x
        pkt.extend_from_slice(&0u32.to_le_bytes()); // y
        pkt.extend_from_slice(&w.to_le_bytes());
        pkt.extend_from_slice(&h.to_le_bytes());
        pkt.extend_from_slice(body);
        pkt
    }

    fn register_test_client(room: &mut RoomState, client_id: usize) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(64);
        room.clients.insert(
            client_id,
            ClientHandle {
                tx,
                kick: Arc::new(Notify::new()),
                live: true,
                sync_in_progress: false,
            },
        );
        rx
    }

    #[test]
    fn test_monotonic_seq_overwrites_spoofed_seq_and_orders_concurrent_edits() {
        let mut room = RoomState::new("Room".to_string());
        let mut rx_host = register_test_client(&mut room, 1);
        let mut rx_guest = register_test_client(&mut room, 2);

        // Host registers & seeds doc
        let join_host = serde_json::json!({
            "type": "JOIN_REQUEST",
            "peer": { "id": "host-1", "name": "Host", "color": "#fff", "isHost": true }
        });
        room.handle_text_object(1, join_host.as_object().unwrap().clone());

        let seed = serde_json::json!({
            "type": "DOC_SYNC_RESPONSE",
            "targetPeerId": "__server__",
            "dimensions": { "width": 1000, "height": 800 },
            "colorMode": "color",
            "layers": [
                { "id": "l1", "name": "Layer 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null }
            ]
        });
        room.handle_text_object(1, seed.as_object().unwrap().clone());
        assert!(room.doc.initialized);
        let seed_seq = room.seq;
        assert_eq!(seed_seq, 1);

        // Concurrent edits with spoofed seq values
        let edit1 = serde_json::json!({
            "type": "LAYER_OPACITY",
            "layerId": "l1",
            "opacity": 0.4,
            "seq": 99999
        });
        room.handle_text_object(1, edit1.as_object().unwrap().clone());

        let edit2 = serde_json::json!({
            "type": "LAYER_OPACITY",
            "layerId": "l1",
            "opacity": 0.75,
            "seq": 1
        });
        room.handle_text_object(2, edit2.as_object().unwrap().clone());

        // Binary tile with spoofed seq 999
        let tile_pkt = make_tile_packet("l1", 1, 2, 5, TILE_CODEC_LZ4, &[1, 2, 3, 4]);
        room.handle_binary_frame(1, tile_pkt);

        // Verify strict monotonic server seq assignment
        let Message::Text(g_msg1) = rx_guest.try_recv().unwrap() else {
            panic!("expected text");
        };
        let v1: serde_json::Value = serde_json::from_str(&g_msg1).unwrap();
        assert_eq!(v1["seq"].as_u64(), Some(2));

        let Message::Text(h_msg2) = rx_host.try_recv().unwrap() else {
            panic!("expected text");
        };
        let v2: serde_json::Value = serde_json::from_str(&h_msg2).unwrap();
        assert_eq!(v2["seq"].as_u64(), Some(3));

        let Message::Binary(g_bin) = rx_guest.try_recv().unwrap() else {
            panic!("expected binary");
        };
        let stamped_seq = u32::from_le_bytes([g_bin[3], g_bin[4], g_bin[5], g_bin[6]]);
        assert_eq!(stamped_seq, 4);

        // Final canonical layer opacity on server reflects edit2 (seq=3)
        assert_eq!(room.doc.layers[0]["opacity"].as_f64(), Some(0.75));
        assert_eq!(room.tiles.len(), 1);
        assert_eq!(room.op_log.len(), 3);
    }

    #[tokio::test]
    async fn test_new_peer_syncs_directly_from_server_without_blocking_host() {
        let state = AppState {
            room_name: "Studio".to_string(),
            room_token: Arc::new("tok".to_string()),
            local_ip: "127.0.0.1".to_string(),
            port: 0,
            tunnel_origin: Arc::new(std::sync::RwLock::new(None)),
            room: Arc::new(std::sync::Mutex::new(RoomState::new("Studio".to_string()))),
            client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
            connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
                CONNECT_BURST,
                CONNECT_REFILL_PER_SEC,
            ))),
        };

        let mut rx_host;
        let mut rx_guest;
        let guest_tx;
        let sync_plan;

        {
            let mut room = state.room.lock().unwrap();
            rx_host = register_test_client(&mut room, 1);

            // Host joins and seeds document + tiles + mask
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "host-1", "name": "Host", "color": "#111", "isHost": true }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "DOC_SYNC_RESPONSE",
                    "targetPeerId": "__server__",
                    "dimensions": { "width": 1440, "height": 900 },
                    "colorMode": "color",
                    "layers": [
                        { "id": "l1", "name": "Host 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null, "hasMask": true },
                        { "id": "layer-bg", "name": "Background", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null }
                    ]
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            // Tile v1 then overwritten by v2; tile (0,1) created then tombstoned
            room.handle_binary_frame(1, make_tile_packet("l1", 0, 0, 1, TILE_CODEC_LZ4, &[10, 20]));
            room.handle_binary_frame(1, make_tile_packet("l1", 0, 0, 2, TILE_CODEC_LZ4, &[30, 40, 50]));
            room.handle_binary_frame(1, make_tile_packet("l1", 0, 1, 1, TILE_CODEC_LZ4, &[99]));
            room.handle_binary_frame(1, make_tile_packet("l1", 0, 1, 2, TILE_CODEC_EMPTY, &[]));
            // Mask solid fill
            room.handle_binary_frame(1, make_mask_packet("l1", MASK_FLAG_FULL_REPLACE | 0x04, 1440, 900, &[255]));

            // Guest connects and sends JOIN_REQUEST
            rx_guest = register_test_client(&mut room, 2);
            guest_tx = room.clients.get(&2).unwrap().tx.clone();
            let outcome = room.handle_text_object(
                2,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "guest-2", "name": "Bob", "color": "#222", "isHost": false }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            sync_plan = match outcome {
                HandleTextOutcome::StartSync { plan, .. } => plan,
                _ => panic!("expected server-direct StartSync"),
            };

            // Simulate concurrent host edit arriving WHILE guest sync is in flight!
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "LAYER_RENAME",
                    "layerId": "l1",
                    "newName": "Renamed During Sync"
                })
                .as_object()
                .unwrap()
                .clone(),
            );
        }

        // Host must NEVER receive JOIN_REQUEST (only LAYER_ADD + PEER_JOINED)
        let mut host_types = Vec::new();
        while let Ok(Message::Text(t)) = rx_host.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            host_types.push(v["type"].as_str().unwrap().to_string());
        }
        assert_eq!(host_types, vec!["LAYER_ADD", "PEER_JOINED"]);

        // Run server direct sync task to completion
        run_client_sync_task(state.clone(), 2, guest_tx, sync_plan).await;

        // Guest receives: JOIN_ACCEPTED -> DOC_SYNC_RESPONSE -> 1 latest tile (v2) -> 1 mask -> tail LAYER_RENAME!
        let Message::Text(m1) = rx_guest.try_recv().unwrap() else { panic!("expected JOIN_ACCEPTED") };
        let j1: serde_json::Value = serde_json::from_str(&m1).unwrap();
        assert_eq!(j1["type"], "JOIN_ACCEPTED");
        assert_eq!(j1["assignedLayerId"], "layer-guest-2-1");
        assert_eq!(j1["hostId"], "host-1");

        let Message::Text(m2) = rx_guest.try_recv().unwrap() else { panic!("expected DOC_SYNC_RESPONSE") };
        let j2: serde_json::Value = serde_json::from_str(&m2).unwrap();
        assert_eq!(j2["type"], "DOC_SYNC_RESPONSE");
        assert_eq!(j2["layers"].as_array().unwrap().len(), 3);
        assert_eq!(j2["layers"][0]["id"], "layer-guest-2-1");

        let Message::Binary(b_tile) = rx_guest.try_recv().unwrap() else { panic!("expected BINARY_TILE") };
        assert_eq!(b_tile[2], CODE_TILE_DELTA);
        let (_, ver, is_empty) = parse_tile_delta_header(&b_tile[BINARY_HEADER_BYTES..]).unwrap();
        assert_eq!(ver, 2); // latest version, tombstone (0,1) excluded
        assert!(!is_empty);

        let Message::Binary(b_mask) = rx_guest.try_recv().unwrap() else { panic!("expected BINARY_MASK") };
        assert_eq!(b_mask[2], CODE_LAYER_MASK_DATA);

        // Tail op arrived during sync is replayed in order AFTER snapshot
        let Message::Text(m_tail) = rx_guest.try_recv().unwrap() else { panic!("expected tail LAYER_RENAME") };
        let j_tail: serde_json::Value = serde_json::from_str(&m_tail).unwrap();
        assert_eq!(j_tail["type"], "LAYER_RENAME");
        assert_eq!(j_tail["newName"], "Renamed During Sync");
        assert!(rx_guest.try_recv().is_err());
        assert!(state.room.lock().unwrap().clients.get(&2).unwrap().live);
    }

    #[tokio::test]
    async fn test_incremental_doc_sync_request_and_security_guards() {
        let state = AppState {
            room_name: "SecRoom".to_string(),
            room_token: Arc::new("tok".to_string()),
            local_ip: "127.0.0.1".to_string(),
            port: 0,
            tunnel_origin: Arc::new(std::sync::RwLock::new(None)),
            room: Arc::new(std::sync::Mutex::new(RoomState::new("SecRoom".to_string()))),
            client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
            connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
                CONNECT_BURST,
                CONNECT_REFILL_PER_SEC,
            ))),
        };

        let mut rx_guest;
        let guest_tx;
        let inc_plan;

        {
            let mut room = state.room.lock().unwrap();
            let _rx_host = register_test_client(&mut room, 1);
            rx_guest = register_test_client(&mut room, 2);
            guest_tx = room.clients.get(&2).unwrap().tx.clone();

            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "host-1", "name": "Host", "color": "#000", "isHost": true }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "DOC_SYNC_RESPONSE",
                    "targetPeerId": "__server__",
                    "dimensions": { "width": 512, "height": 512 },
                    "colorMode": "color",
                    "layers": [
                        { "id": "f1", "name": "Folder", "type": "folder", "parentId": null },
                        { "id": "c1", "name": "Child", "type": "raster", "parentId": "f1" }
                    ]
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            let baseline_seq = room.seq;

            // Rogue guest attempts to hijack host and overwrite document snapshot -> must fail
            room.handle_text_object(
                2,
                serde_json::json!({
                    "type": "DOC_SYNC_RESPONSE",
                    "targetPeerId": "__server__",
                    "dimensions": { "width": 10, "height": 10 },
                    "colorMode": "monochrome",
                    "layers": [{ "id": "evil", "name": "Evil", "type": "raster", "parentId": null }]
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            assert_eq!(room.doc.layers.len(), 2);
            assert_eq!(room.doc.layers[0]["id"], "f1");

            // Host adds tile on child, then deletes parent folder -> subtree + tile pruned
            room.handle_binary_frame(1, make_tile_packet("c1", 0, 0, 1, TILE_CODEC_LZ4, &[7, 8]));
            assert_eq!(room.tiles.len(), 1);
            room.handle_text_object(
                1,
                serde_json::json!({ "type": "LAYER_DELETE", "layerId": "f1" })
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            assert!(room.doc.layers.is_empty());
            assert!(room.tiles.is_empty());

            // Drain guest's live messages before testing incremental replay
            while rx_guest.try_recv().is_ok() {}

            // Guest asks for incremental catch-up from baseline_seq
            let outcome = room.handle_text_object(
                2,
                serde_json::json!({
                    "type": "DOC_SYNC_REQUEST",
                    "targetPeerId": "guest-2",
                    "sinceSeq": baseline_seq
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            inc_plan = match outcome {
                HandleTextOutcome::StartSync {
                    plan:
                        SyncPlan::Incremental {
                            join_accepted,
                            since_seq,
                        },
                    ..
                } => {
                    assert_eq!(since_seq, baseline_seq);
                    SyncPlan::Incremental {
                        join_accepted,
                        since_seq,
                    }
                }
                _ => panic!("expected Incremental sync plan"),
            };
        }

        run_client_sync_task(state.clone(), 2, guest_tx, inc_plan).await;

        // Replays exact 2 ops since baseline_seq: BINARY_TILE then LAYER_DELETE
        let Message::Binary(b1) = rx_guest.try_recv().unwrap() else { panic!("expected tile op") };
        assert_eq!(b1[2], CODE_TILE_DELTA);
        let Message::Text(t2) = rx_guest.try_recv().unwrap() else { panic!("expected delete op") };
        let j2: serde_json::Value = serde_json::from_str(&t2).unwrap();
        assert_eq!(j2["type"], "LAYER_DELETE");
        assert!(rx_guest.try_recv().is_err());
    }

    fn make_test_app_state() -> AppState {
        AppState {
            room_name: "TestRoom".to_string(),
            room_token: Arc::new("tok".to_string()),
            local_ip: "127.0.0.1".to_string(),
            port: 30303,
            tunnel_origin: Arc::new(std::sync::RwLock::new(None)),
            room: Arc::new(std::sync::Mutex::new(RoomState::new("TestRoom".to_string()))),
            client_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS)),
            connect_limiter: Arc::new(std::sync::Mutex::new(TokenBucket::new(
                CONNECT_BURST,
                CONNECT_REFILL_PER_SEC,
            ))),
        }
    }

    #[tokio::test]
    async fn test_reconnect_catchup_by_seq_and_host_hijack_prevention() {
        let state = make_test_app_state();
        let (host_tx, _rx_host) = mpsc::channel::<Message>(64);
        let (guest_tx, mut rx_guest) = mpsc::channel::<Message>(64);
        let (reconn_tx, mut rx_reconn) = mpsc::channel::<Message>(64);

        let guest_baseline_seq: u64;
        {
            let mut room = state.room.lock().unwrap();
            room.clients.insert(
                1,
                ClientHandle {
                    tx: host_tx.clone(),
                    kick: Arc::new(Notify::new()),
                    live: true,
                    sync_in_progress: false,
                },
            );
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "host-1", "name": "Host", "color": "#fff", "isHost": true }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            room.handle_text_object(
                1,
                serde_json::json!({
                    "type": "DOC_SYNC_RESPONSE",
                    "targetPeerId": "__server__",
                    "dimensions": { "width": 512, "height": 512 },
                    "colorMode": "color",
                    "layers": [
                        { "id": "layer-host", "name": "Host 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null, "ownerPeerId": "host-1", "ownerPeerName": "Host" }
                    ]
                })
                .as_object()
                .unwrap()
                .clone(),
            );

            // Guest joins initially
            room.clients.insert(
                2,
                ClientHandle {
                    tx: guest_tx.clone(),
                    kick: Arc::new(Notify::new()),
                    live: true,
                    sync_in_progress: false,
                },
            );
            let _ = room.handle_text_object(
                2,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "guest-a", "name": "Alice", "color": "#0f0", "isHost": false }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            // Mark guest live and snapshot baseline seq
            if let Some(c) = room.clients.get_mut(&2) {
                c.live = true;
                c.sync_in_progress = false;
            }
            guest_baseline_seq = room.seq;

            // Guest disconnects temporarily
            room.disconnect_client(2, Some("guest-a".to_string()));
            // Host also disconnects temporarily to test hijack prevention
            room.disconnect_client(1, Some("host-1".to_string()));

            // Attacker tries to claim isHost:true while real host is disconnected
            room.clients.insert(
                3,
                ClientHandle {
                    tx: reconn_tx.clone(),
                    kick: Arc::new(Notify::new()),
                    live: true,
                    sync_in_progress: false,
                },
            );
            let _ = room.handle_text_object(
                3,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "attacker", "name": "Evil", "color": "#f00", "isHost": true }
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            assert_eq!(room.host_peer_id.as_deref(), Some("host-1"));
            assert_ne!(room.host_client_id, Some(3));
            assert_eq!(room.client_role(3), PeerRole::Editor);
            room.disconnect_client(3, Some("attacker".to_string()));

            // Real host reconnects and produces a tile + layer rename while guest-a is offline
            room.clients.insert(
                4,
                ClientHandle {
                    tx: host_tx.clone(),
                    kick: Arc::new(Notify::new()),
                    live: true,
                    sync_in_progress: false,
                },
            );
            room.handle_text_object(
                4,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "host-1", "name": "Host", "color": "#fff", "isHost": true },
                    "isReconnect": true,
                    "sinceSeq": guest_baseline_seq
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            assert_eq!(room.host_client_id, Some(4));

            room.handle_binary_frame(4, make_tile_packet("layer-host", 0, 0, 7, TILE_CODEC_RAW, &[1, 2, 3, 4]));
            room.handle_text_object(
                4,
                serde_json::json!({
                    "type": "LAYER_RENAME",
                    "layerId": "layer-host",
                    "newName": "Inked"
                })
                .as_object()
                .unwrap()
                .clone(),
            );
        }

        // Now guest-a reconnects with isReconnect: true and sinceSeq = guest_baseline_seq
        let plan = {
            let mut room = state.room.lock().unwrap();
            room.clients.insert(
                5,
                ClientHandle {
                    tx: reconn_tx.clone(),
                    kick: Arc::new(Notify::new()),
                    live: true,
                    sync_in_progress: false,
                },
            );
            let outcome = room.handle_text_object(
                5,
                serde_json::json!({
                    "type": "JOIN_REQUEST",
                    "peer": { "id": "guest-a", "name": "Alice", "color": "#0f0", "isHost": false },
                    "isReconnect": true,
                    "sinceSeq": guest_baseline_seq
                })
                .as_object()
                .unwrap()
                .clone(),
            );
            match outcome {
                HandleTextOutcome::StartSync {
                    plan:
                        SyncPlan::Incremental {
                            join_accepted,
                            since_seq,
                        },
                    ..
                } => {
                    assert!(join_accepted.is_some());
                    assert_eq!(since_seq, guest_baseline_seq);
                    SyncPlan::Incremental {
                        join_accepted,
                        since_seq,
                    }
                }
                _ => panic!("expected Incremental catch-up on reconnect"),
            }
        };

        while rx_reconn.try_recv().is_ok() {}
        while rx_guest.try_recv().is_ok() {}

        run_client_sync_task(state.clone(), 5, reconn_tx, plan).await;

        let mut saw_join_accepted = false;
        let mut saw_tile = false;
        let mut saw_rename = false;
        while let Ok(msg) = rx_reconn.try_recv() {
            match msg {
                Message::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    if v["type"] == "JOIN_ACCEPTED" {
                        assert_eq!(v["isReconnect"], true);
                        saw_join_accepted = true;
                    } else if v["type"] == "LAYER_RENAME" && v["newName"] == "Inked" {
                        saw_rename = true;
                    }
                }
                Message::Binary(b) => {
                    if b.len() > 2 && b[2] == CODE_TILE_DELTA {
                        saw_tile = true;
                    }
                }
                _ => {}
            }
        }
        assert!(saw_join_accepted);
        assert!(saw_tile);
        assert!(saw_rename);
    }

    #[test]
    fn test_roles_owner_lock_delete_protection_and_kick_ban() {
        let mut room = RoomState::new("ModRoom".to_string());
        let (host_tx, _rx_host) = mpsc::channel::<Message>(64);
        let (alice_tx, mut rx_alice) = mpsc::channel::<Message>(64);
        let (bob_tx, mut rx_bob) = mpsc::channel::<Message>(64);

        let alice_kick = Arc::new(Notify::new());
        let bob_kick = Arc::new(Notify::new());

        room.clients.insert(
            1,
            ClientHandle {
                tx: host_tx,
                kick: Arc::new(Notify::new()),
                live: true,
                sync_in_progress: false,
            },
        );
        room.clients.insert(
            2,
            ClientHandle {
                tx: alice_tx,
                kick: Arc::clone(&alice_kick),
                live: true,
                sync_in_progress: false,
            },
        );
        room.clients.insert(
            3,
            ClientHandle {
                tx: bob_tx,
                kick: Arc::clone(&bob_kick),
                live: true,
                sync_in_progress: false,
            },
        );

        // Register Host, Alice (editor), Bob (editor)
        room.handle_text_object(
            1,
            serde_json::json!({
                "type": "JOIN_REQUEST",
                "peer": { "id": "host-1", "name": "Host", "color": "#fff", "isHost": true }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        room.handle_text_object(
            1,
            serde_json::json!({
                "type": "DOC_SYNC_RESPONSE",
                "targetPeerId": "__server__",
                "dimensions": { "width": 512, "height": 512 },
                "colorMode": "color",
                "layers": [
                    { "id": "layer-alice", "name": "Alice 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null, "ownerPeerId": "alice", "ownerPeerName": "Alice" },
                    { "id": "layer-bob", "name": "Bob 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null, "ownerPeerId": "bob", "ownerPeerName": "Bob" }
                ]
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        room.handle_text_object(
            2,
            serde_json::json!({
                "type": "JOIN_REQUEST",
                "peer": { "id": "alice", "name": "Alice", "color": "#0f0", "isHost": false }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        room.handle_text_object(
            3,
            serde_json::json!({
                "type": "JOIN_REQUEST",
                "peer": { "id": "bob", "name": "Bob", "color": "#00f", "isHost": false }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        // Flip to live
        room.clients.get_mut(&2).unwrap().live = true;
        room.clients.get_mut(&2).unwrap().sync_in_progress = false;
        room.clients.get_mut(&3).unwrap().live = true;
        room.clients.get_mut(&3).unwrap().sync_in_progress = false;
        while rx_alice.try_recv().is_ok() {}
        while rx_bob.try_recv().is_ok() {}

        // 1. Bob cannot delete Alice's layer (protection against accidental deletion)
        room.handle_text_object(
            3,
            serde_json::json!({ "type": "LAYER_DELETE", "layerId": "layer-alice" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(room.doc.layers.iter().any(|l| layer_id_of(l) == Some("layer-alice")));
        let Message::Text(denied_txt) = rx_bob.try_recv().unwrap() else { panic!("expected denied") };
        let denied_json: serde_json::Value = serde_json::from_str(&denied_txt).unwrap();
        assert_eq!(denied_json["type"], "ACCESS_DENIED");
        assert_eq!(denied_json["code"], "NOT_OWNER");

        // 2. Bob also cannot delete Alice's layer via LAYER_TREE_SYNC
        room.handle_text_object(
            3,
            serde_json::json!({
                "type": "LAYER_TREE_SYNC",
                "layers": [
                    { "id": "layer-bob", "name": "Bob 1", "type": "raster", "visible": true, "opacity": 1.0, "blendMode": "normal", "locked": false, "parentId": null, "ownerPeerId": "bob" }
                ]
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert!(room.doc.layers.iter().any(|l| layer_id_of(l) == Some("layer-alice")));
        while rx_bob.try_recv().is_ok() {}

        // 3. Alice locks her layer by owner -> Bob cannot paint tiles or rename or unlock it
        room.handle_text_object(
            2,
            serde_json::json!({
                "type": "LAYER_UPDATE",
                "layerId": "layer-alice",
                "patch": { "reservedByPeerId": "alice", "reservedByPeerName": "Alice" }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        while rx_bob.try_recv().is_ok() {}

        room.handle_binary_frame(3, make_tile_packet("layer-alice", 0, 0, 1, TILE_CODEC_RAW, &[9, 9, 9]));
        assert!(room.tiles.is_empty());
        let Message::Text(lock_denied) = rx_bob.try_recv().unwrap() else { panic!("expected lock denied") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&lock_denied).unwrap()["code"], "LAYER_LOCKED");

        // 4. Non-host cannot demote someone else
        room.handle_text_object(
            3,
            serde_json::json!({ "type": "PEER_ROLE_UPDATE", "targetPeerId": "alice", "role": "viewer" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(room.client_role(2), PeerRole::Editor);
        while rx_bob.try_recv().is_ok() {}

        // 5. Host demotes Bob to Viewer -> Bob cannot draw even on his own layer, and Viewer persists across reconnect
        room.handle_text_object(
            1,
            serde_json::json!({ "type": "PEER_ROLE_UPDATE", "targetPeerId": "bob", "role": "viewer" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(room.client_role(3), PeerRole::Viewer);
        while rx_bob.try_recv().is_ok() {}

        room.handle_binary_frame(3, make_tile_packet("layer-bob", 0, 0, 2, TILE_CODEC_RAW, &[7, 7, 7]));
        assert!(room.tiles.is_empty());
        let Message::Text(viewer_denied) = rx_bob.try_recv().unwrap() else { panic!("expected viewer denied") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&viewer_denied).unwrap()["code"], "VIEWER_READONLY");

        // 6. Host bans Alice -> releases Alice's layer lock, removes Alice, blocks Alice rejoin until unban
        room.handle_text_object(
            1,
            serde_json::json!({ "type": "PEER_BAN", "targetPeerId": "alice", "reason": "Griefing" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(room.banned_peer_ids.contains("alice"));
        assert!(!room.clients.contains_key(&2));
        let alice_layer = room.doc.layers.iter().find(|l| layer_id_of(l) == Some("layer-alice")).unwrap();
        assert!(alice_layer.get("reservedByPeerId").is_none());

        // Alice tries to rejoin while banned -> immediately denied & removed
        let (alice2_tx, mut rx_alice2) = mpsc::channel::<Message>(16);
        room.clients.insert(
            9,
            ClientHandle {
                tx: alice2_tx,
                kick: Arc::new(Notify::new()),
                live: true,
                sync_in_progress: false,
            },
        );
        room.handle_text_object(
            9,
            serde_json::json!({
                "type": "JOIN_REQUEST",
                "peer": { "id": "alice", "name": "Alice", "color": "#0f0", "isHost": false }
            })
            .as_object()
            .unwrap()
            .clone(),
        );
        assert!(!room.clients.contains_key(&9));
        let Message::Text(ban_msg) = rx_alice2.try_recv().unwrap() else { panic!("expected ban denial") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&ban_msg).unwrap()["code"], "BANNED");

        // Host unbans Alice -> allowed to rejoin
        room.handle_text_object(
            1,
            serde_json::json!({ "type": "PEER_UNBAN", "targetPeerId": "alice" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert!(!room.banned_peer_ids.contains("alice"));
    }
}
