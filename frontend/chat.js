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
 * - chat_error: string - error message
 */

import { ws } from "./websocket.js";

const MAX_PENDING_IDS = 400;

// Module state
const contacts = new Map();        // uid -> {callsign, group_name, group_role, stale}
const threads = new Map();         // threadKey -> {key, kind, name, messages[], unread}
const pendingIds = new Map();      // threadKey -> Set(message_id)
let selectedThread = null;
let selfInfo = { uid: "", callsign: "" };

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
        return contact?.callsign || threadKey;
    }
    return thread.name || threadKey;
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
    if (sendBtn) {
        sendBtn.addEventListener("click", sendMessage);
    }

    // Enter key in input
    const input = $("chatInput");
    if (input) {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }
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
            callsign: payload.self.callsign || ""
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
function handleChatError(error) {
    console.error("Chat error:", error);
    const input = $("chatInput");
    if (input) {
        input.placeholder = `Error: ${error}`;
    }
}

/**
 * Select a thread (channel or DM)
 */
function selectThread(threadKey) {
    selectedThread = threadKey;
    const thread = threads.get(threadKey);
    if (thread) {
        thread.unread = 0;
    }
    refreshAll();

    // Focus input
    const input = $("chatInput");
    if (input) input.focus();
}

/**
 * Send a chat message
 */
function sendMessage() {
    if (!selectedThread) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const input = $("chatInput");
    if (!input) return;

    const text = input.value.trim();
    if (!text) return;

    const thread = threads.get(selectedThread);
    if (!thread) return;
    const isDM = thread.kind === "dm";
    const messageId = crypto.randomUUID();

    // Optimistic UI: add local message immediately
    const optimisticMsg = {
        uid: `local-${messageId}`,
        type: "b-t-f",
        how: "h-g-i-g-o",
        time: new Date().toISOString(),
        thread: selectedThread,
        room: isDM ? getThreadDisplayName(selectedThread) : selectedThread,
        kind: thread.kind,
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
    const rooms = [...threads.values()].filter(t => t.kind !== "dm");
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
    for (const t of rooms) {
        html += `<div class="chat-channel${t.key === selectedThread ? " active" : ""}" data-key="${escapeHtml(t.key)}">
            <span>${escapeHtml(getThreadDisplayName(t.key))}</span>
            ${t.unread > 0 ? `<span class="chat-badge">${t.unread > 99 ? "99+" : t.unread}</span>` : ""}
        </div>`;
    }

    html += '<div class="chat-channel-section">Users</div>';
    // Combine DM threads and contacts without threads
    const allDMs = [...dms, ...contactThreads];
    for (const t of allDMs) {
        const isActive = t.key === selectedThread;
        html += `<div class="chat-channel${isActive ? " active" : ""}" data-key="${escapeHtml(t.key)}">
            <span>${escapeHtml(getThreadDisplayName(t.key))}</span>
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
    input.disabled = false;
    sendBtn.disabled = false;

    if (!thread || thread.messages.length === 0) {
        threadDiv.innerHTML = '<div class="chat-empty">No messages yet</div>';
        return;
    }

    let html = "";
    for (const msg of thread.messages) {
        const classes = ["chat-msg", msg.self ? "self" : ""];
        if (msg.pending) classes.push("pending");
        html += `<div class="${classes.join(" ")}">
            <span class="chat-meta">${escapeHtml(msg.sender)} &middot; ${formatTime(msg.time)}</span>
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