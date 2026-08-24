# Chapter 13 — Troubleshooting

## Nothing connects / "Disconnected" in the status bar

1. Check your own network (can you reach other websites?).
2. Reload the page (`F5`). You will return to the login screen if your
   session ended; sign in again.
3. If it still fails, the TAK server may be down — contact your
   administrator.

## I'm not visible to others / others are not visible to me

- Did you complete the identity setup (callsign/color/role)? Without a
  saved callsign you never join the network (Chapter 3).
- Your presence disappears about a minute after closing the tab and
  reappears shortly after signing in. Give it a moment.
- Check the **Channels** window — if you are unsubscribed from everything,
  you will not hear channel traffic (Chapter 11).

## Chat doesn't work

- The message field is greyed out when the connection is down. Fix the
  connection first.
- If an error text appears in the input field, read it — most commonly it
  means the message was empty or too long (maximum 4000 characters).

## A checkmark on my message never turns ✓✓

✓✓ appears only after the recipient actually opens that conversation. No
response yet does not mean failure.

## Login fails

- Passwords are case-sensitive; check `Caps Lock`.
- After three failed attempts, the device wipes that account's stored
  credentials for security. Enroll or import the certificate again
  (Chapter 2).
- "Certificate expired": your certificate has run out — get a new one and
  enroll/upload again.

## Certificate upload fails

- Make sure you selected the correct `.p12` file and entered **its**
  password (not your usual login password).
- The file must be a personal certificate with its private key, not just a
  certificate chain.

## Channels window shows an error

The viewer could not reach the server's management interface at that
moment. Wait a few seconds and reopen the window. If it persists, the
server's API port may be blocked — report it to your administrator.

## My position marker is in the wrong place

Set your location again with the map zoomed well in (Chapter 9). Browser
location can be inaccurate indoors — picking on the map at your actual
position is more precise.

## The map is empty except base map

- Filters may be hiding units: press **Clear** next to the search box.
- *Show callsigns* only hides labels, not symbols — symbols would still be
  there.
- If truly nothing arrives, see the first item above.

## Text is too small

Use `Ctrl` + mouse wheel to zoom the whole page, or `F11` for full-screen
mode.

## The browser warns about the website's security

Some units run the viewer without a publicly trusted certificate. Follow
your local guidance — typically your administrator provides the address in
a way your browser already trusts. Never proceed past a security warning
you cannot explain.

## Still stuck?

Note what you clicked last, what appeared on screen and the time (the Zulu
clock helps), and contact your system administrator.
