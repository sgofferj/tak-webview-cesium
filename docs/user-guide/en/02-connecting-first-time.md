# Chapter 2 — Connecting for the First Time

When you open the map for the first time, you will see a welcome screen
asking how you want to connect. There are three options. **Your unit will
tell you which one applies to you** — usually it is one of the first two.

## Option A — Enrollment (you have a TAK username and password)

This creates your personal certificate automatically.

1. Click **Enrollment**.
2. Fill in:
   - **TAK Server** — the address of your unit's server (your
     administrator gives you this). If the field is not shown, the server
     is already set for you.
   - **Username** and **Password** — your TAK server account.
3. Click **Enroll**.

If it works, a green message confirms your enrollment and the setup screen
for your identity appears (Chapter 3).

## Option B — Certificate upload (you have a `.p12` file)

Some units hand out a personal certificate file instead.

1. Click **Certificate Upload**.
2. Fill in:
   - **TAK Server** — your unit's server address, if asked.
   - **Choose file / p12 file** — select your certificate file.
   - **Password** — the password that protects that file.
3. Click **Upload & Connect**.

### If a "new password" field appears

The application checks whether your certificate file is protected well
enough. If its password is too weak (shorter than 8 characters, or the
well-known default `atakatak`), a second password field appears. You must:

- Enter a **new password of at least 8 characters**, which must not be
  `atakatak` or your own username, and then
- Click **Upload & Connect** again.

From then on, this new password is what you use to log in on this device.
Remember it — there is no password reminder.

## Option C — Login (this device was used before)

If you or a colleague has already enrolled on this device with their
account, you can simply sign in again:

1. Click **Login**.
2. Enter your **username** and **password**.
3. Click **Login**.

> **Careful:** after **three failed login attempts in a row**, the stored
> credentials for that username are wiped from this device as a security
> measure. You would then need to enroll or import the certificate again.

## After connecting

Once you are in, continue with Chapter 3 to set your callsign, team color
and role. This is required before you appear on the network.
