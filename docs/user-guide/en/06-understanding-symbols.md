# Chapter 6 — Understanding the Symbols

## The basics

Every tracked thing on the map appears as a military symbol according to
the MIL-STD-2525 standard — the same symbology used by ATAK and other
tactical systems. You do not need to know the standard to read the map:

- **The symbol's shape** tells you what it is (infantry, aircraft,
  vessel, vehicle, headquarters…).
- **The symbol's frame color** tells you whose side it is on:
  - **Cyan/blue** — friendly
  - **Red** — hostile
  - **Green** — neutral
  - **Yellow** — unknown

## Team circles (people)

Connected team members appear as **colored circles** instead of standard
military symbols. The circle color is the member's team color (Chapter 3),
and a role abbreviation inside the circle shows their function. For
example, a medic of the Red team and a team lead of the Blue team look
like this:

![Red team medic](../images/team-red-medic.png) ![Blue team lead](../images/team-blue-team-lead.png)

| Abbreviation | Role |
| ------------ | ---- |
| TL | Team Lead |
| MD | Medic |
| SN | Sniper |
| FO | Forward Observer |
| RO | RTO |
| K9 | K9 unit |
| PL | Pilot |
| HQ | Headquarters |

Plain colored circle without letters = Team Member.

## Callsign labels

Each symbol carries its callsign next to it in a small label.

- Use the **Show callsigns** checkbox in the sidebar to hide or show all
  labels.
- Labels adapt to zoom: they disappear when symbols get too dense and
  reappear as you zoom in. A selected unit always keeps its label.

## Course arrows and trails

- A small white **arrow** next to a moving unit points in its direction of
  travel; it rotates with the map view:

  ![Course arrow](../images/course-arrow.png)

- When you select a unit, its recent **movement trail** appears as a line.
  Deselect the unit to hide the trail again.

## Selecting a unit and reading its details

Click any symbol to open its info box. Depending on what data the unit
reports, the box can contain:

- Callsign and type
- Position in latitude/longitude **and MGRS**
- Altitude, course and speed
- Contact details (radio/XMPP identity, e-mail, phone) if provided
- **Battery level** with a colored gauge (green/orange/red)
- **Emergency indicators** — transponder codes such as 7700 (emergency),
  7600 (radio failure), 7500 (hijack) are shown prominently in red
- Remarks text, where **hashtags** like `#incident-alpha` are clickable —
  clicking one filters the map to all units carrying that tag
- External links, for example to a vessel or flight tracker

Emergency situations are also flagged in the unit list with a red badge.

## Staff comment highlighting

If your administrator configured keywords (for example `#SF` for Shadow
Fleet), units whose remarks match them are highlighted and grouped in the
sidebar under **Staff Comments** (Chapter 7).
