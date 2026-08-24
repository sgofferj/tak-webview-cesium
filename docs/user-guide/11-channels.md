# Chapter 11 — Channels

## What channels are

Your TAK server organizes users into groups called **channels** (in ATAK
they appear as groups like `Team Lead`, `Restricted`, or your unit's own
names). Being subscribed to a channel means:

- **IN** — you hear what is sent on that channel
- **OUT** — what you send reaches that channel's members

Which channels you may join is decided by the server administrator. Which
ones you actually listen to is up to you.

## Opening the channel list

Click **Channels** in the status bar. A window lists every channel you are
entitled to, with a checkbox next to each. The list is fetched fresh from
the server every time you open it, so it always reflects the current
state.

- **Checked** = subscribed (both listening and reaching that channel)
- **Unchecked** = not subscribed

There is no separate IN/OUT switch — one checkbox controls both directions,
which matches how channels are normally used.

## Changing your subscription

1. Open **Channels**.
2. Tick the boxes for the channels you want; untick those you don't.
3. Click **Save**.

The change takes effect immediately on the server. Clicking outside the
window or pressing Cancel closes it without changes.

> **Note:** Unsubscribing from a channel means messages sent to that
> channel no longer reach you — including ones sent while you were
> unsubscribed. There is no catch-up.

## When the list fails to load

If the window shows an error instead of channels, the viewer could not
reach your TAK server's management interface at that moment. Check your
connection indicator, wait a moment and try again (Chapter 13).

## How this relates to chat rooms

Channels are *server-level* subscriptions controlled by your entitlements.
The automatic rooms in chat (team colors, roles, All Chat Rooms) are
*conversation* rooms built from who is currently online. You normally do
not need to touch Channels unless your administrator tells you which
channels your role requires.
