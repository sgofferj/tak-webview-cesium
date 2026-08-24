# Chapter 12 — Signing Out and Security

## The two ways to leave

### Logout

Ends your session but **keeps your credentials on this device**, so you
(or another authorized user) can sign in again with just username and
password.

1. Click **Logout** in the status bar.
2. You return to the welcome screen.

Use Logout for short breaks or shared workstations where the device is
trusted.

### Forget (logout and wipe)

Ends your session and **deletes all your data from this device** —
certificate, stored credentials, saved settings.

1. Click **Forget**.
2. Confirm when asked.

Afterwards, this device no longer knows you; connecting again requires a
full enrollment or certificate import (Chapter 2). Use Forget on shared or
less trusted devices, before handing a laptop to another user, or if a
device may be lost.

## What happens on the network when you leave

Closing the tab, logging out or losing connection removes your symbol from
other users' maps within a minute. Your chat conversations remain visible
to others as history.

## Failed logins

After **three failed login attempts**, the stored credentials for that
username are wiped from the device as a protection against guessing. This
is deliberate — contact your administrator to re-enroll if it happens.

## Expired certificates

Your certificate has an expiry date; the status bar shows it color-coded
(green → orange → red). When it has expired:

- Login is refused and the stored record is wiped automatically.
- You must enroll or import again once you hold a valid certificate.

Watch for the status turning orange/red — renew through your certificate
office in time.

## How your data is protected

- Your private key is **stored encrypted** on the server that runs the map,
  locked with your password. It is only decrypted in working memory while
  connecting, never written to disk unencrypted.
- Your username is not exposed on the network — your network identity is a
  scrambled code derived from it.
- Nothing about your session persists in the browser beyond display
  preferences (camera position, filters, chosen layers).
- Logging out drops the decryption keys from memory; other users' data is
  never touched by your logout.

> **Remember:** anyone at your screen while you are signed in acts as you.
> Lock your workstation (`Win+L` / `Ctrl+Cmd+Q`) when stepping away, or log
> out.
