// chat.js from https://github.com/sgofferj/tak-webview-cesium
//
// Copyright Stefan Gofferje
//
// Licensed under the Gnu General Public License Version 3 or higher (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at https://www.gnu.org/licenses/gpl-3.0.en.html

/**
 * Chat module handling geochat panel UI and messaging.
 * Backend sends these message types:
 * - chat_init: {self, threads, contacts} - initial state on connect
 * - chat: {thread, kind, message_id, sender, text, time, self, ...} - new message
 * - contacts_update: {uid: {callsign, group_name, group_role}} - contact list update
 * - chat_receipt: {message_id, status} - delivery/read receipt for a sent message
 * - chat_error: string - error message
 */

import { ws } from "./websocket.js";
import { i18n } from "./config.js";
import { renderGoogleIcon } from "./utils.js";
import { getEntityIconUrl } from "./state.js";

const MAX_PENDING_IDS = 400;

// System room constants (must match the backend's CHAT_ROOM_ALL)
const ROOM_ALL_KEY = "All Chat Rooms";
const ROOM_COLORS = new Map([
    ["White", "#ffffff"],
    ["Yellow", "#ffff00"],
    ["Orange", "#ffa500"],
    ["Magenta", "#ff00ff"],
    ["Red", "#ff0000"],
    ["Maroon", "#800000"],
    ["Purple", "#800080"],
    ["Cyan", "#00ffff"],
    ["Blue", "#0000ff"],
    ["Green", "#00ff00"],
    ["Dark Green", "#006400"],
    ["Brown", "#a52a2a"],
    ["Teal", "#008080"],
]);
const ROOM_ROLE_ABBR = {
    HQ: "HQ",
    "Team Member": "",
    "Team Lead": "TL",
    Sniper: "SN",
    Medic: "MD",
    "Forward Observer": "FO",
    RTO: "RO",
    K9: "K9",
    Pilot: "PL",
    Gateway: "GAT",
};

// Module state
const contacts = new Map();        // uid -> {callsign, group_name, group_role, stale}
const threads = new Map();         // threadKey -> {key, kind, name, messages[], unread}
const pendingIds = new Map();      // threadKey -> Set(message_id)
const receiptStatus = new Map();   // message_id -> "delivered" | "read"
const readSignaled = new Set();    // message_ids a chat_read was already sent for
const roomIconCache = new Map();   // "kind:key" -> data URL of the room icon
let selectedThread = null;
let selfInfo = { uid: "", callsign: "", color: "", role: "" };
let chatConnected = false;

/**
 * HTML escape helper
 */
function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "\u0026\u0061\u006d\u0070;")
        .replaceAll("<", "\u0026\u006c\u0074;")
        .replaceAll(">", "\u0026\u0067\u0074;")
        .replaceAll('"', "\u0026\u0071\u0075\u006f\u0074;")
        .replaceAll("'", "\u0026\u0023\u0039\u0036;");
}

/**
 * Get display name for a thread
 * DM threads show contact's callsign; rooms show room name
 */
function getThreadDisplayName(threadKey) {
    const thread = threads.get(threadKey);
    if (!thread) {
        // Check contacts map directly for DMs without threads
        const contact = contacts.get(threadKey);
        return contact?.callsign || threadKey;
    }

    if (thread.kind === "dm") {
        const contact = contacts.get(threadKey);
        return contact?.callsign || thread.name || threadKey;
    }
    return thread.name || threadKey;
}

/**
 * Build the data-URL icon for a room channel.
 * kind is one of "all", "color" or "role".
 */
function drawRoomIcon(kind, key) {
    const cacheKey = `${kind}:${key}`;
    if (roomIconCache.has(cacheKey)) return roomIconCache.get(cacheKey);

    const size = 28;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const cx = size / 2;
    const radius = size / 2 - 1;

    if (kind === "all") {
        const iconCanvas = renderGoogleIcon("forum", "#ffffff", size, false, false);
        const iconUrl = iconCanvas.toDataURL("image/png");
        roomIconCache.set(cacheKey, iconUrl);
        return iconUrl;
    }

    if (kind === "color") {
        ctx.beginPath();
        ctx.arc(cx, cx, radius, 0, 2 * Math.PI);
        ctx.fillStyle = ROOM_COLORS.get(key) || "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000000";
        ctx.stroke();
    } else if (kind === "role") {
        const abbr =
            ROOM_ROLE_ABBR[key] ||
            (key ? key.substring(0, 3).toUpperCase() : "");
        ctx.beginPath();
        ctx.arc(cx, cx, radius, 0, 2 * Math.PI);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000000";
        ctx.stroke();
        if (abbr) {
            ctx.fillStyle = "#000000";
            ctx.font = `bold ${size * 0.45}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(abbr, cx, cx + 0.5);
        }
    }

    const iconUrl = canvas.toDataURL("image/png");
    roomIconCache.set(cacheKey, iconUrl);
    return iconUrl;
}

/**
 * Whether a channel key is a system room (All Chat Rooms, color or role).
 */
function isSystemRoomKey(key) {
    return (
        key === ROOM_ALL_KEY ||
        ROOM_COLORS.has(key) ||
        Object.prototype.hasOwnProperty.call(ROOM_ROLE_ABBR, key)
    );
}

/**
 * Fitting icon for any room key (system, color, role or generic).
 */
function getRoomIcon(key) {
    if (key === ROOM_ALL_KEY) return drawRoomIcon("all", key);
    if (ROOM_COLORS.has(key)) return drawRoomIcon("color", key);
    if (Object.prototype.hasOwnProperty.call(ROOM_ROLE_ABBR, key)) {
        return drawRoomIcon("role", key);
    }
    return drawRoomIcon("all", key);
}

/**
 * Icon for a room, preferring an explicit kind ("all" | "color" | "role").
 */
function roomIconFor(kind, key) {
    return kind ? drawRoomIcon(kind, key) : getRoomIcon(key);
}

/**
 * System rooms created from the visible roster:
 * - "All Chat Rooms" unconditionally
 * - one room per visible color (incl. our own)
 * - one room per visible role other than "Team Member" (incl. our own)
 */
function buildSystemRooms() {
    const colors = new Set();
    const roles = new Set();
    for (const c of contacts.values()) {
        if (c.group_name) colors.add(c.group_name);
        if (c.group_role && c.group_role !== "Team Member") roles.add(c.group_role);
    }
    if (selfInfo.color) colors.add(selfInfo.color);
    if (selfInfo.role && selfInfo.role !== "Team Member") roles.add(selfInfo.role);

    const rooms = [
        { key: ROOM_ALL_KEY, kind: "room", name: ROOM_ALL_KEY, iconKind: "all", icon: roomIconFor("all", ROOM_ALL_KEY) },
    ];
    for (const color of colors) {
        rooms.push({ key: color, kind: "room", name: color, iconKind: "color", icon: roomIconFor("color", color) });
    }
    for (const role of roles) {
        rooms.push({ key: role, kind: "room", name: role, iconKind: "role", icon: roomIconFor("role", role) });
    }
    return rooms;
}

/**
 * Room channels for the list: system rooms merged with live room threads.
 */
function roomChannelList() {
    const roomThreads = [...threads.values()].filter(t => t.kind !== "dm");
    const liveKeys = new Set(roomThreads.map(t => t.key));
    const system = buildSystemRooms().filter(r => !liveKeys.has(r.key));
    const named = roomThreads.map(t => ({
        ...t,
        icon: getRoomIcon(t.key),
    }));
    return [...system, ...named];
}

/**
 * Check if chat panel is currently open
 */
function isChatOpen() {
    const panel = document.getElementById("chatPanel");
    return panel && !panel.classList.contains("collapsed");
}

/**
 * Get DOM element by ID
 */
function $(id) {
    return document.getElementById(id);
}

/**
 * Initialize chat module - called from main.js
 */
export function initChat() {
    console.debug("initChat: called");
    // Channel list click handler
    const channelList = $("chatChannelList");
    if (channelList) {
        channelList.addEventListener("click", (e) => {
            const channel = e.target.closest(".chat-channel");
            if (channel && channel.dataset.key) {
                selectThread(channel.dataset.key);
            }
        });
    }

    // Send button handler
    const sendBtn = $("chatSend");
    console.debug("initChat: sendBtn=", sendBtn);
    if (sendBtn) {
        sendBtn.addEventListener("click", sendMessage);
    }

    // Enter key in input
    const input = $("chatInput");
    console.debug("initChat: input=", input);
    if (input) {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    // Refresh channel list when a client's map icon becomes available
    document.addEventListener("cot-icon-ready", (e) => {
        const uid = e.detail?.uid;
        if (uid && (contacts.has(uid) || threads.has(uid))) {
            refreshAll();
        }
    });
}

/**
 * Update whether the websocket (and therefore send) is available.
 * Called from websocket.js on open/close.
 */
export function setChatConnected(connected) {
    chatConnected = connected;
    renderThread();
}

/**
 * Handle incoming websocket messages
 * Called from websocket.js onmessage
 */
export function handleChatMessage(data) {
    if (data.chat_init !== undefined) {
        handleChatInit(data.chat_init);
    } else if (data.chat !== undefined) {
        handleIncomingChat(data.chat);
    } else if (data.contacts_update !== undefined) {
        handleContactsUpdate(data.contacts_update);
    } else if (data.chat_receipt !== undefined) {
        handleChatReceipt(data.chat_receipt);
    } else if (data.chat_error !== undefined) {
        handleChatError(data.chat_error);
    }
}

/**
 * Handle chat_init - initial state
 */
function handleChatInit(payload) {
    if (payload.self) {
        selfInfo = {
            uid: payload.self.uid || "",
            callsign: payload.self.callsign || "",
            color: payload.self.color || "",
            role: payload.self.role || ""
        };
    }

    // Clear existing state
    contacts.clear();
    threads.clear();
    pendingIds.clear();
    selectedThread = null;

    // Load contacts
    if (payload.contacts) {
        for (const [uid, info] of Object.entries(payload.contacts)) {
            contacts.set(uid, info);
        }
    }

    // Load threads and messages
    if (payload.threads) {
        for (const [threadKey, messages] of Object.entries(payload.threads)) {
            if (!Array.isArray(messages) || messages.length === 0) continue;

            // Determine thread kind from first message
            const firstMsg = messages[0];
            const kind = firstMsg.kind || (firstMsg.peer ? "dm" : "room");

            const thread = {
                key: threadKey,
                kind,
                name: firstMsg.room || threadKey,
                messages: [],
                unread: 0
            };

            // Add messages (oldest first)
            for (const msg of messages) {
                insertMessage(msg, true);
            }

            threads.set(threadKey, thread);
        }
    }

    refreshAll();
}

/**
 * Handle new chat message
 */
function handleIncomingChat(msg) {
    insertMessage(msg);
}

/**
 * Insert a message into its thread
 */
function insertMessage(msg, isHistory = false) {
    const threadKey = msg.thread;
    if (!threadKey) return;

    let thread = threads.get(threadKey);
    if (!thread) {
        thread = {
            key: threadKey,
            kind: msg.kind || (msg.peer ? "dm" : "room"),
            name: msg.room || threadKey,
            messages: [],
            unread: 0
        };
        threads.set(threadKey, thread);
    }

    // Track pending IDs for deduplication
    let pending = pendingIds.get(threadKey);
    if (!pending) {
        pending = new Set();
        pendingIds.set(threadKey, pending);
    }

    // Deduplicate: if we already have this message_id (optimistic send), mark as confirmed
    if (pending.has(msg.message_id)) {
        const existing = thread.messages.find(m => m.message_id === msg.message_id);
        if (existing && existing.pending) {
            existing.pending = false;
            refreshAll();
            return;
        }
    }

    // Limit pending IDs set size
    if (pending.size >= MAX_PENDING_IDS) {
        pending.clear();
    }
    pending.add(msg.message_id);

    // Add message
    thread.messages.push(msg);

    // Increment unread if not current thread and panel not open
    if (!isHistory && !(isChatOpen() && selectedThread === threadKey)) {
        thread.unread += 1;
    }

    // New message in the open thread: send the read receipt right away
    if (!isHistory && isChatOpen() && selectedThread === threadKey) {
        signalReadForThread(threadKey);
    }

    refreshAll();
}

/**
 * Handle contacts update
 */
function handleContactsUpdate(payload) {
    if (!payload || typeof payload !== "object") return;

    let changed = false;
    for (const [uid, info] of Object.entries(payload)) {
        const existing = contacts.get(uid);
        if (!existing || existing.callsign !== info.callsign) {
            changed = true;
        }
        contacts.set(uid, info);
    }

    if (changed) {
        refreshAll();
    }
}

/**
 * Handle cot_delete - remove contacts (and their DM threads) whose SA
 * was deleted via t-x-d-d.
 */
export function handleCotDelete(uids) {
    if (!Array.isArray(uids)) return;

    let changed = false;
    for (const uid of uids) {
        if (threads.delete(uid)) {
            if (selectedThread === uid) selectedThread = null;
            pendingIds.delete(uid);
            changed = true;
        }
        if (contacts.delete(uid)) {
            changed = true;
        }
    }
    if (changed) {
        refreshAll();
    }
}
function handleChatError(error) {
    console.error("Chat error:", error);
    const input = $("chatInput");
    if (input) {
        input.placeholder = `Error: ${error}`;
    }
}

/**
 * Handle a delivery/read receipt (b-t-f-d/b-t-f-r) for one of our messages
 */
function handleChatReceipt(receipt) {
    if (!receipt || !receipt.message_id) return;
    receiptStatus.set(
        receipt.message_id,
        receipt.status === "read" ? "read" : "delivered"
    );
    refreshAll();
}

/**
 * Send chat_read for every received message in a thread once it is viewed.
 */
function signalReadForThread(threadKey) {
    const thread = threads.get(threadKey);
    if (!thread) return;
    if (!isChatOpen() || selectedThread !== threadKey) return;
    for (const msg of thread.messages) {
        if (msg.self || !msg.message_id) continue;
        if (msg.pending || readSignaled.has(msg.message_id)) continue;
        readSignaled.add(msg.message_id);
        if (ws && ws.readyState === WebSocket.OPEN && chatConnected) {
            ws.send(
                JSON.stringify({
                    chat_read: { thread: threadKey, message_id: msg.message_id }
                })
            );
        }
    }
}

/**
 * Delivery/read checkmark for messages we sent.
 */
function statusCheckmark(messageId) {
    if (!messageId) return "";
    const status = receiptStatus.get(messageId);
    if (status === "read") {
        return ` <span class="chat-status" title="${i18n.chatRead || "Read"}">✓✓</span>`;
    }
    if (status === "delivered") {
        return ` <span class="chat-status" title="${i18n.chatDelivered || "Delivered"}">✓</span>`;
    }
    return "";
}

/**
 * Select a thread (channel or DM)
 */
function selectThread(threadKey) {
    console.debug("selectThread:", threadKey);
    selectedThread = threadKey;
    const thread = threads.get(threadKey);
    if (thread) {
        thread.unread = 0;
    }
    refreshAll();
    signalReadForThread(threadKey);

    // Focus input
    const input = $("chatInput");
    if (input) input.focus();
}
function sendMessage() {
    if (!selectedThread) return;
    if (!chatConnected || !ws || ws.readyState !== WebSocket.OPEN) return;

    const input = $("chatInput");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    const thread = threads.get(selectedThread);
    const contact = contacts.get(selectedThread);
    if (!thread && !contact && !isSystemRoomKey(selectedThread)) return;
    const isDM = thread?.kind === "dm" || !!contact;
    const messageId = crypto.randomUUID();

    // Optimistic UI: add local message immediately
    const optimisticMsg = {
        uid: `local-${messageId}`,
        type: "b-t-f",
        how: "h-g-i-g-o",
        time: new Date().toISOString(),
        thread: selectedThread,
        room: isDM ? getThreadDisplayName(selectedThread) : selectedThread,
        kind: isDM ? "dm" : "room",
        message_id: messageId,
        sender: selfInfo.callsign || "Me",
        sender_uid: selfInfo.uid || "",
        peer: isDM ? selectedThread : null,
        text,
        self: true,
        pending: true
    };

    insertMessage(optimisticMsg);
    input.value = "";

    // Send via websocket
    console.debug("sendMessage: ws.readyState=", ws?.readyState, "WebSocket.OPEN=", WebSocket.OPEN, "isDM=", isDM, "selectedThread=", selectedThread);
    const payload = {
        chat_send: {
            room: isDM ? null : selectedThread,
            peer_uid: isDM ? selectedThread : null,
            peer_callsign: isDM ? getThreadDisplayName(selectedThread) : null,
            text,
            client_id: messageId
        }
    };
    try {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
            console.debug("sendMessage: sent payload", payload);
        } else {
            console.error("sendMessage: websocket not open, readyState=", ws?.readyState);
        }
    } catch (e) {
        console.error("Failed to send chat:", e);
    }
}

/**
 * Refresh channel list (left panel)
 */
function renderChannelList() {
    const container = $("chatChannelList");
    if (!container) return;

    // Separate rooms and DMs
    const dms = [...threads.values()].filter(t => t.kind === "dm");

    // Also include contacts that don't have a thread yet (for starting new DMs)
    const contactThreads = [...contacts.entries()]
        .filter(([uid]) => !threads.has(uid))
        .map(([uid, info]) => ({
            key: uid,
            kind: "dm",
            name: info.callsign || uid,
            messages: [],
            unread: 0
        }));

    let html = '<div class="chat-channel-section">Rooms</div>';
    for (const t of roomChannelList()) {
        html += `<div class="chat-channel${t.key === selectedThread ? " active" : ""}" data-key="${escapeHtml(t.key)}">
            <span class="chat-channel-label">
                ${t.icon ? `<img class="chat-room-icon" src="${t.icon}" alt="">` : ""}
                <span class="chat-channel-name">${escapeHtml(getThreadDisplayName(t.key))}</span>
            </span>
            ${t.unread > 0 ? `<span class="chat-badge">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}
        </div>`;
    }

    html += '<div class="chat-channel-section">Users</div>';
    // Combine DM threads and contacts without threads
    const allDMs = [...dms, ...contactThreads];
    for (const t of allDMs) {
        const isActive = t.key === selectedThread;
        const icon = getEntityIconUrl(t.key);
        html += `<div class="chat-channel${isActive ? " active" : ""}" data-key="${escapeHtml(t.key)}">
            <span class="chat-channel-label">
                ${icon ? `<img class="chat-client-icon" src="${icon}" alt="">` : ""}
                <span class="chat-channel-name">${escapeHtml(getThreadDisplayName(t.key))}</span>
            </span>
            ${t.unread > 0 ? `<span class="chat-badge">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}
        </div>`;
    }

    container.innerHTML = html;
}

/**
 * Refresh thread view (right panel)
 */
function renderThread() {
    const header = $("chatThreadHeader");
    const threadDiv = $("chatThread");
    const input = $("chatInput");
    const sendBtn = $("chatSend");

    console.debug("renderThread: selectedThread=", selectedThread, "sendBtn=", sendBtn, "thread=", threads.get(selectedThread));

    if (!header || !threadDiv || !input || !sendBtn) return;

    if (!selectedThread) {
        header.textContent = "";
        threadDiv.innerHTML = '<div class="chat-empty">Select a channel to start chatting</div>';
        input.disabled = true;
        sendBtn.disabled = true;
        return;
    }

    const thread = threads.get(selectedThread);
    header.textContent = getThreadDisplayName(selectedThread);
    input.disabled = !chatConnected;
    sendBtn.disabled = !chatConnected;

    if (!thread || thread.messages.length === 0) {
        threadDiv.innerHTML = '<div class="chat-empty">No messages yet</div>';
        return;
    }

    let html = "";
    for (const msg of thread.messages) {
        const classes = ["chat-msg", msg.self ? "self" : ""];
        if (msg.pending) classes.push("pending");
        const status = msg.self ? statusCheckmark(msg.message_id) : "";
        html += `<div class="${classes.join(" ")}">
            <span class="chat-meta">${escapeHtml(msg.sender)} &middot; ${formatTime(msg.time)}${status}</span>
            ${escapeHtml(msg.text)}
        </div>`;
    }
    threadDiv.innerHTML = html;
    threadDiv.scrollTop = threadDiv.scrollHeight;
}

/**
 * Format timestamp for display
 */
function formatTime(isoString) {
    try {
        const date = new Date(isoString);
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

/**
 * Refresh unread badge on chat toggle button
 */
function renderUnreadBadge() {
    const badge = $("chatUnread");
    if (!badge) return;

    let total = 0;
    for (const t of threads.values()) {
        total += t.unread;
    }

    if (total > 0) {
        badge.textContent = total > 99 ? "99+" : String(total);
        badge.classList.add("visible");
    } else {
        badge.classList.remove("visible");
    }
}

/**
 * Refresh all chat UI
 */
function refreshAll() {
    renderChannelList();
    renderThread();
    renderUnreadBadge();
}

// Expose for debugging
window.__chatDebug = {
    get contacts() { return contacts; },
    get threads() { return threads; },
    get selectedThread() { return selectedThread; },
    get selfInfo() { return selfInfo; }
};