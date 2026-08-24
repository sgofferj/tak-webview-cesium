# CODE_GUIDE.fi.md — Toiminnallinen ja arkkitehtuurikuvaus

**Projekti:** tak-webview-cesium
**Kohderyhmä:** Auditoret ja uudet kehittäjät
**Laajuus:** Koodikannan täydellinen toiminnallinen kuvaus 24.8.2026
(haara `feat/channel-selection`, commit `bfa9edd`).

Lisenssoitu GNU General Public License V3 tai uudempi -lisenssillä.
(C) 2026 Stefan Gofferje

---

## Sisällysluettelo

1. [Mikä tämä sovellus on](#1-mikä-tämä-sovellus-on)
2. [Ylätason arkkitehtuuri](#2-ylätason-arkkitehtuuri)
3. [Ominaisuuksien yleiskatsaus](#3-ominaisuuksien-yleiskatsaus)
4. [Koodikartta — mistä mitäkin löytyy](#4-koodikartta--mistä-mitäkin-löytyy)
5. [Taustajärjestelmän moduulit tarkemmin](#5-taustajärjestelmän-moduulit-tarkemmin)
6. [Frontend-moduulit tarkemmin](#6-frontend-moduulit-tarkemmin)
7. [Datan virtaukset](#7-datan-virtaukset)
8. [Tietoturvamalli](#8-tietoturvamalli)
9. [Konfiguraatioviite](#9-konfiguraatioviite)
10. [Testit ja työkalut](#10-testit-ja-työkalut)

---

## 1. Mikä tämä sovellus on

tak-webview-cesium on selainpohjainen TAK (Team Awareness Kit) -asiakasohjelma.
Se yhdistää TAK-palvelimeen mTLS-yhteydellä, striimaa Cursor-on-Target (CoT) -
tapahtumia, piirtää kaikki taktiset entiteetit ("atomit") CesiumJS-3D-globille
ja tarjoaa täyden geochatin (ATAK-yhteensopiva `b-t-f`-viestintä) kontakteineen,
huoneineen, toimitus-/lukukuittauksineen sekä TAK-palvelimen kanavien
(ryhmien) tilaushallinnan.

Sovellus koostuu kahdesta osasta:

| Osa       | Teknologia                                        | Rooli |
| --------- | ------------------------------------------------- | ----- |
| Tausta    | Python 3.11, FastAPI, Poetry                      | TLS/CoT-yhteys TAK-palvelimeen, auth/enrollment, sertifikaattiholvi, WebSocket-keskitin, Marti REST -välityspalvelin |
| Frontend  | Vite (Vanilla JS ES -moduulit), CesiumJS, milsymbol | Karttapiirto, entiteettiloopsi, chat-UI, auth/konfig-UI |

Tausta palvelee buildatun frontendin staattisena tiedostona; originia ja
porttia on yksi (oletuksena 8000). Selain ei koskaan puhu suoraan
TAK-palvelimelle — kaikki kulkee taustajärjestelmän kautta.

### Suunnittelufilosofia: "Never-Unencrypted-on-Disk"

Yksityiset avaimet salataan levolla Fernet-salauksella avaimella, joka
johdetaan käyttäjän salasanasta (PBKDF2-SHA256, 100k kierrosta).
Purettuja avaimia on olemassa **vain RAM-muistissa**, ja ne syötetään
OpenSSL:lle Linuxin `memfd`-tiedostokuvausten kautta — niitä ei koskaan
kirjoiteta levyllä salaamattomana. Kaikki käyttäjädata sijaitsee
katoavassa hakemistossa ja pyyhitään uloskirjautumisessa (wipe),
kolmella epäonnistuneella kirjautumisella tai kun sertifikaatti vanhenee.

---

## 2. Ylätason arkkitehtuuri

```
┌──────────────────────────── Selain ─────────────────────────────┐
│  index.html + main.js                                           │
│  ├── viewer.js   (Cesium-viewer, imagery, terrain, overlayt)    │
│  ├── state.js    (entiteettitila, suodattimet, yksikkölista)    │
│  ├── chat.js     (chat-paneelin UI)                             │
│  ├── websocket.js (WS-asiakas, msgpack-dekoodaus)               │
│  └── config.js / utils.js / i18n-lokaalit                       │
└─────────────▲──────────────────────────────▲────────────────────┘
      HTTP REST (JSON)              WebSocket (/ws, msgpack+JSON)
│             │                              │                    │
┌─────────────▼──────────────────────────────▼──────────────────┐ │
│ FastAPI-sovellus — backend/app/main.py                        │
│  ├── auth.py        enrollment, P12-tuonti, login, RAM-avaimet│
│  ├── users.py       käyttäjärekisteri, PBKDF2/Fernet-krypto   │
│  ├── clients.py     ClientPool: yksi TAKClient per käyttäjä   │
│  ├── tak_client.py  CoT-striimi, keepalive, geochat, kuittaukset│
│  ├── connection.py  WS-hubi (käyttäjäkohtainen reititys) + SessionTracker│
│  ├── groups.py      Marti REST -välitys (kanavatilaukset)     │
│  └── layers.py / iconsets.py / config.py                      │
└─────────────▲──────────────────────────────▲────────────────────┘
              │ mTLS TCP :8089               │ mTLS HTTPS :8443 (Marti API)
              ▼                              ▼
        TAK Server 5.x  ◄──── enrollment-API :8446 (TLS)
```

### Keskeiset ajosäännöt

- Käyttäjän TAK-asiakas käynnistyy **vasta** sen jälkeen, kun käyttäjä on
  vahvistanut viestintäkonfiguraationsa (tunnus/väri/rooli)
  konfiguraatioikkunassa — ei kirjautumisen yhteydessä.
- Se pysähtyy automaattisesti, kun käyttäjän viimeinen selainasiakas
  (selainvälilehti) katkaisee yhteyden (`main.py`:n websocket-lohkon
  `finally` → `pool.stop_user`).
- Jokainen rekisteröitynyt käyttäjä saa oman TAK-yhteyden ja erillisen UID:n,
  joka johdetaan käyttäjänimen SHA-256-hashista (`users.py:
  uid_for_username`), joten useampi käyttäjä samassa asennuksessa näkyy
  TAK-verkossa omina asiakkainaan.

---

## 3. Ominaisuuksien yleiskatsaus

### Autentikointi ja identiteetti
- **Automaattinen enrollment** TAK-palvelimen TLS-enrollment-API:a vasten
  (portti 8446): RSA-avainpari + CSR, palvelimen allekirjoittama
  sertifiikki, valinnainen palvelimen työntämä laiteprofiili
  (tunnus/väri/rooli), jota käytetään viestintäkonfiguraation esitäyttöön.
- **Manuaalinen `.p12`-tuonti**: CN:stä tulee käyttäjänimi; heikot salasanat
  tunnistetaan ja pakotetaan vahvaan uudelleensalaukseen.
- **Kirjautuminen** jo enrolloituille käyttäjille; 3 epäonnistunutta yritystä
  pyyhkii kyseisen käyttäjän tiedot.
- **Yhden palvelimen kiinnitys (pinning)**: `FORCE_SERVER`-ympäristömuuttuja
  tai ensimmäinen onnistunut enrollment/tuonti kiinnittää asennuksen yhteen
  TAK-palvelimeen; poikkeamat hylätään taustajärjestelmässä.
- **Uloskirjautuminen vs. uloskirjautuminen ja unohdus**: tavallinen
  uloskirjautuminen säilyttää sertifikaatit mutta pudottaa RAM-avaimet;
  "unohda" pyyhkii vain kirjautuneen käyttäjän datan.

### Visualisointi
- CesiumJS-3D-globi konfiguroitavilla peruskartoilla (WMS, XYZ/TMS,
  ArcGIS MapServer), mukautettu terrain-palveluntarjoaja,
  korkeuden exaggeration, tumman kartan tunnistus ja korrokäyrät
  (vain tumma kartta + terrain).
- MIL-STD-2525-symbolit milsymbol-kirjastolla; joukkuevärin ympyräkuvakkeet
  SA-entiteeteille, joilla on `__group`; iconset-tuki
  (`iconset.xml`-joukot hakemistoista `/iconsets` ja `/app/user_iconsets`);
  eksplisiittinen SIDC-overrde detail-kentistä `__milsym`/`__milicon`.
- Per entiteetti: kutsimerkki-label (kytkettävissä), liikerata,
  kurssi/nopeusnuoli, infolaatikko MGRS:llä, yhteystiedot, akkumittari,
  squawk-hätälabelit, klikattavat hashtagit, ulkoiset linkit.
- Suodattimet: vapaa teksti, affiliaatio, dimensio; zoomista riippuva
  labelien näkyvyys; kamerakaltevuudentietoiset display-ehdot;
  "Zoom to All" poikkeama-arvoja karsien; vanhentuneiden entiteettien
  siivous (stale + 120 s armoväli).
- Paikalliset tiedosto-overlayt (GeoJSON/KML/CZML hakemistosta
  `/app/overlays`) oikealla klikkauksella avautuvalla tyylimuokkaimella
  (väri, viivatyyli, leveys, täyttö, läpinäkyvyys), polygonien ääriviivat
  erillisinä polylineinä, polygonien maantieteellisen keskipisteen labelit
  `Rectangle`-luokalla.
- Oma sijainti -merkki: valitse kartalta tai selaimen geolokaatiosta,
  tallennettu per käyttäjä, syötetään TAK SA -sijaintiraporttiin.

### Viestintä (geochat)
- Täysi ATAK 5.8 -lankamuotoisen `b-t-f`-chatin tuki: huoneet ja yksityis-
  viestit (DM:t kantavat `<marti><dest uid=.../></marti>`-elementin, jotta
  palvelin reitittää ne 1:1).
- Ketjuhistoria (rajatut ring bufferit, vain RAM), kontaktien seuranta
  live-SA-liikenteestä, järjestelmähuoneiden automaattinen luonti
  ("All Chat Rooms", joukkueväriä kohden, roolia kohden), lukemattomien
  viestien merkitsimet, optimistinen lähetys deduplikoinnilla.
- Toimitus (`b-t-f-d`) ja lukemis (`b-t-f-r`) kuittaukset ✓/✓✓-UI:lla,
  peilatun `__chatreceipt`-rakennelman tuotto, automaattinen toimitus-
  kuittaus vastaanotossa ja lukukuittaus ketjua katsottaessa.
- `t-x-d-d`-poistojen käsittely poistaa entiteetit JA kontaktit/DM-ketjut.

### Kanavat (TAK-palvelimen ryhmätilaukset)
- Tilapalkin "Channels"-ponnahdusikkuna listaa käyttäjän oikeuttamat
  TAK-palvelimen ryhmät yhdistetyllä IN/OUT-tilaustilanteella (yksi
  checkbox kattaa molemmat suunnat).
- Tausta välittää Marti-ryhmä-REST-API-kutsut mTLS:llä käyttäjän omalla
  sertifiikilla: `GET /Marti/api/groups/user` ja absoluuttinen
  `PUT /Marti/api/groups/active`.

### Alustaominaisuudet
- Monikäyttäjä-yksipalvelinkäyttö: käyttäjäkohtaiset sertifikaatit,
  sessiot, identiteetit ja chat-tilat; täysin eristetty logout/wipe.
- i18n: englanti, saksa, ruotsi, suomi (selainkielen tunnistus).
- Konfiguroitava brändäys (otsikko, logo, sijainti), GoTo-pikanavigointi-
  napit, Zulu-kello, sessiojen jatkuvuus (kamera/suodattimet/kerrokset
  localStoragessa), health-endpoint access-lokeista pois, MessagePack +
  entiteettikohtainen throttle frontend-liikenteen optimointiin,
  staff comment -korostukset.

---

## 4. Koodikartta — mistä mitäkin löytyy

### Repositorion rakenne

```
backend/
  pyproject.toml          Poetry-riippuvuudet + ruff/mypy/pylint/pytest-konf
  main.py                 Kontin käynnistyspiste (uvicorn)
  app/
    main.py               FastAPI-sovellus: reitit, websocket, lifespan
    config.py             Pydantic Settings (env-muuttujat), validaattorit
    auth.py               AuthManager: enroll/upload-p12/login/wipe, RAM-sessiot
    users.py              UserRegistry: käyttäjäkohtainen tallennus, PBKDF2/Fernet
    tak_client.py         TAKClient: CoT-striimi, keepalive, parsinta, geochat
    clients.py            ClientPool avaimella (server, username)
    connection.py         ConnectionManager (WS-hubi) + SessionTracker
    groups.py             Marti-ryhmä-REST-välitys (kanavat)
    layers.py             customlayers.json -lataaja, WMS-extentin tunnistus
    iconsets.py           iconset.xml -skanneri/välimuisti
  tests/
    conftest.py           Jaetut fixturet (tmp ephemeral -hakemisto, settings)
    test_config.py        Settings/env-validointi
    test_cot_parsing.py   CoT XML -> sanakirja -parsijan testit
    test_users.py         Rekisterin/kryptoprimitiivien testit
    test_clients.py       ClientPool-käyttäytymisen testit
    test_multiuser.py     Monikäyttäjäeristyksen skenaariot
    test_server_pinning.py FORCE_SERVER / pin-semantiikka
    test_chat_roundtrip.py Chatin parse/build -roundtrip-testit
    test_chat_receipts.py b-t-f-d / b-t-f-r -kuittausten käsittely
    test_groups.py        Kanavaoikeuksien redusointi + PUT-rungon rakennus
frontend/
  index.html              Yhden sivun kuori: auth-overlay, sivupalkki, tilapalkki,
                          chat-paneeli, modaalit (~1675 riviä markupia + CSS)
  main.js                 Käynnistys, auth-UI-virrat, konfig-overlay, kanava-
                          ponnahdus, kerrosvalitsin, oman sijainnin valinta
  state.js                Entiteettitilakone, näkyvyys/suodattimet,
                          yksikkölista, staff commentit, stale-sweep
  viewer.js               Cesium-init, imagery/terrain-tarjoajat, overlayt,
                          korroanalyysi
  chat.js                 Chat-paneeli: ketjut, kontaktit, kuittaukset, lähetys
  websocket.js            WS-asiakas, msgpack-dekoodaus, reconnect
  config.js               /config-haku, i18n-lataus, staattiset käännökset
  utils.js                CoT->SIDC-mappaus, MGRS, ikonit, throttle
  public/locales/*.json   en/de/sv/fi-käännökset
  iconsets/               Mukana toimitetut MIL-STD-2525-iconsetit (mount /iconsets)
customlayers.json         Esimerkki mukautetuista karttalähteistä
Dockerfile                Kaksivaiheinen build: node (vite build) -> python-runtime
MULTIUSER_PLAN.md         Siirretyn multiserver-suunnitelman muistiinpanot
```

### Pikahakutaulu

| Tarvitsen muuttaa/löytää…                     | Katso |
| --------------------------------------------- | ----- |
| HTTP-endpointin                                | `backend/app/main.py` |
| Env-muuttujien käsittely / sallitut värit ja roolit | `backend/app/config.py` (`Settings`) |
| Enrollment-virta (CSR, signClient, profiilizip)| `backend/app/auth.py: enroll()`, `_fetch_enrollment_profile()` |
| P12-tuonti / salasanakovennus                  | `backend/app/auth.py: upload_p12()` |
| Avainten salaus / RAM-only-dekryptaus          | `backend/app/users.py` (krypto), `auth.py: get_private_key()`, `tak_client.py: build_ssl_context_for_user()` |
| Kirjautumissäännöt (3 osuman wipe)             | `main.py: auth_login()` + `auth.py: record_failed_login()/wipe_user()` |
| CoT-langan parsinta (XML → dict)               | `tak_client.py: parse_cot()` |
| Keepalive/ping/dead-link-ajastimet             | `tak_client.py: _heartbeat_loop()` (vakiot RX_STALE/PING_INTERVAL/RX_DEAD) |
| Lähtevät CoT-tapahtumat (SA, ping, self-delete)| `tak_client.py: _build_sa_event/_build_ping_event/_build_self_delete_event` |
| Chatin lankamuoto (b-t-f build/parse)          | `tak_client.py: _build_chat_event/parse_chat` |
| DM 1:1-reititys (`<marti><dest>`)              | `tak_client.py: _build_chat_event` (is_dm-haara) |
| Kuittaukset (✓ / ✓✓)                           | `tak_client.py: parse_receipt/_extract_receipt_mirror/_build_receipt_event/send_chat_read`; frontend `chat.js: handleChatReceipt/statusCheckmark/signalReadForThread` |
| Kontaktirekisteri (live-käyttäjälista)         | `tak_client.py: _update_contact` (+ atomihaara run()-loopissa) |
| t-x-d-d-entiteetti-/kontaktipoistot            | `tak_client.py: _parse_delete/_apply_delete`; frontend `state.js: removeEntity`, `chat.js: handleCotDelete` |
| Kanavatilaus                                   | `backend/app/groups.py`; endpointit `main.py: list_channels/update_channels`; frontend `main.js` "Channel Selection Popup" -osa |
| Käyttäjäkohtaisen TAK-clientin elinkaari       | `clients.py` + `main.py: _start_user_client/set_messaging_config` |
| WS-hubi ja käyttäjäkohtainen viesti-eristys    | `connection.py: ConnectionManager.broadcast(username=...)` |
| Sessio→käyttäjä -ratkaisu                      | `connection.py: SessionTracker` + sid:n käyttö `main.py`:ssä |
| CoT:n throttlaus / msgpack-minifiointi         | `tak_client.py: _broadcast_if_needed`, `KEY_MAP` |
| Entiteettien luonti/päivitys/poisto (frontend) | `state.js: updateEntity/_reconcileCesiumEntity/removeEntity/processRemovalQueue` |
| Ikonigeneraatio (milsymbol/joukkueympyrä/iconset) | `state.js: _reconcileCesiumEntity` -ikoniosa + `drawGroupIcon` |
| Näkyvyyssäännöt (DDC, kaltevuus, valinta)      | `state.js: applyFilter/calculateVisibility/updateEntitySelectionVisibility` |
| Suodattimet (teksti/affiliaatio/dimensio)      | `state.js: setFilters/calculateVisibility` |
| Yksikkölista / staff comment -sivupalkki       | `state.js: updateUnitListUI/updateStaffCommentsUI/staffCommentMap` |
| Vanhentuneiden entiteettien siivous            | `state.js: initStateManager` (onTick, 30 s väli, 120 s armoväli) |
| Peruskartat / terrain / korrokäyrät            | `viewer.js` |
| Overlayjen lataus ja tyylittely (GeoJSON/KML/CZML) | `viewer.js: toggleOverlayLayer/applyOverlayStyling` |
| Polygonien keskellä olevat labelit             | `viewer.js: applyOverlayStyling` (Rectangle-keskipiste) |
| Auth-näkymät / konfig-overlay / kanavat-ikkuna | `index.html`-markup + `main.js: checkAuth/setupAuthEvents` |
| Oman sijainnin ominaisuus                      | `main.js` alareuna ("Own location") + `POST /api/messaging/location` |
| Kamera-/sessiojatkuvuus                        | `main.js: saveAppState/loadAppState`, `viewer.js: getCameraState/getLayerState` |
| i18n-merkkijonot                               | `frontend/public/locales/{en,de,sv,fi}.json` + `config.js: loadTranslations/applyStaticTranslations` |
| Uudelleenyhdistämiskäytös (frontend WS)        | `websocket.js: ws.onclose` (4001 = ei reconnectia) |
| Docker-imagen build                            | `Dockerfile` |

---

## 5. Taustajärjestelmän moduulit tarkemmin

### 5.1 `app/config.py` — Settings

Pydantic `BaseSettings`, joka lukee env-muuttujat / `.env`-tiedoston. Ryhmät:

- Yhteys: `TAK_HOST/TAK_PORT/TAK_API_PORT` (striimaava CoT vs. Marti REST -
  API-portti), `TAK_ENROLL_PORT`.
- Identiteetti: oletuskutsimerkki/tyyppi/uid sekä UI:sta valitut
  `callsign/color/role`-overridet. `VALID_COLOURS`/`VALID_ROLES`-frozensetit
  ja kenttävalidaattorit pakottavat whitelistit.
- Tietoturva: `SECRET_KEY` (sessioevästeen allekirjoitus, satunnainen jos
  asettamaton), `TRUSTED_PROXIES` (merkkijono-tai-JSON-listavalidaattori).
- Liikenne: `WS_THROTTLE` (pienin sekuntimäärä päivitysten välillä per UID),
  `USE_MSGPACK`, `LOG_COTS`, `TAK_STAFF_COMMENTS` -map-merkkijono.
- Polut: kiinteät hakemistot `/app/certs/ephemeral`, `/iconsets`,
  `/app/overlays`, `/app/user_iconsets` (propertyt, ei env-konfiguroitavissa).

`uid_for_username()` johdtaa vakaan käyttäjäkohtaisen UID:n
(`CesiumViewer-<sha256(username)[:16]>`) — käyttäjänimeä ei koskaan
lähetetään TAK-verkkoon selkokielisenä.

Singleton-instanssi exportataan nimellä `settings`.

### 5.2 `app/users.py` — UserRegistry ja kryptoprimitiivit

- `UserAccount`: levylle tallennettu JSON polussa
  `<ephemeral>/users/<username>/account.json` (salasanahash, salt, palvelin,
  certin vanheneminen, UID, tallennettu lat/lon). Ei koskaan sisällä
  salaista tietoa selväkielisenä.
- `UserSession`: RAM-only-tietorakenne, joka pitää purettua Fernet-
  storage-avainta.
- `UserRegistry`: tiedostotallennus per käyttäjä (`cert.pem`, salattu
  `cert.key`, `ca.pem`) sekä primitiivit: PBKDF2-SHA256-salasanan hashays
  (100k kierrosta, varmistus `secrets.compare_digest`illä), Fernet-avaimen
  derivointi, deterministinen SHA256-pohjainen enrollment-salaisuus
  (CSR:n yksityisen avaimen purkuun), salasanavahvuuden validointi
  (≥8 merkkiä, ≠ `atakatak`, ≠ käyttäjänimi), tunnistusten varmistus
  joka palauttaa `UserSession`in, sekä `any_certificates_remain()`,
  jota käytetään päätökseen pinin nollauksesta.

### 5.3 `app/auth.py` — AuthManager

Keskeinen autentikoinnin/sertifikaattivallan fasadi (moduulitason singleton
`auth_manager`):

- **Palvelinkiinnitys**: `decide_server()` pakottaa `FORCE_SERVER`- tai
  ensimmäisen enrollmentin/tuonnin kirjaaman palvelimen
  (`pinned_server.json`). Pin nollautuu, kun viimeinen cert katoaa.
- **Enrollment** (`enroll()`): täydellinen TAK-enrollment-tanssi
  osoitteeseen `https://<server>:8446/Marti/api/tls`: GET `/config`
  subject-OID:eja varten → CSR:n rakennus väliaikaisesta RSA-2048-avaimesta →
  POST `/signClient/v2` deterministisellä enrollment-salaisuudella tokenina →
  signedCert/privateKey/CA-ketjun parsinta XML-vastauksesta → toimitetun
  yksityisen avaimen purku enrollment-salaisuudella → uudelleensalaus
  käyttäjän Fernet-storage-avaimella → tallennus per käyttäjä. Sen jälkeen
  haetaan valinnainen enrollment-profiilipaketti
  (`profile/enrollment?clientUid=`) — ZIP, jonka `.pref`-tiedostoista
  parsitaan `locationCallsign/locationTeam/atakRoleType` — pidetään
  kertakäyttönä `_enrollment_profiles`issa konfiguraatio-UI:n esitäyttöä
  varten.
- **P12-tuonti** (`upload_p12()`): PKCS12:n purku, CN:n poiminta
  käyttäjänimeksi, salasanavahvuuden valvonta (pakottaa vahvan korvauksen),
  avaimateriaalin salaus ja tallennus, automaattinen login.
- **Sessiot**: `login()` varmistaa tunnukset ja cacheaa RAM-only-session
  (storage-avain); `drop_session()` poistaa sen; `_activate/_deactivate`
  ylläpitävät aktiivista käyttäjää + ajonaikaista identiteettiä globaaleissa
  asetuksissa.
- **Cert-materiaalin hakufunktiot** TLS-kontekstia varten:
  `get_cert_bytes`, `get_ca_bytes`, `get_private_key` (purku tarvittaessa
  RAM:iin), `get_cert_info` (CN/org/vanheneminen green/orange/red/expired -
  tiloilla).
- **Whitet**: `wipe_user()` poistaa yhden käyttäjän hakemiston + session
  (eristys); `wipe_ephemeral()` tyhjentää koko asennuksen (legacy-polku/testit).

### 5.4 `app/tak_client.py` — TAKClient (sydän)

Yksi instanssi per käyttäjä (`ClientPool`in omistuksessa). Vastuut:

**TLS-asennus** — moduulifunktio `build_ssl_context_for_user(username)`:
lataa cert + puretun avaimen (vain RAM) OpenSSL:ään `os.memfd_create`-
tiedostokuvausten kautta (`/dev/fd/N`-polut), lataa valinnaisesti CA-kimpun;
ilman CA:ta palvelinsertifikaattia ei tarkisteta. Jaettu striimaavan
yhteyden *ja* Marti REST -välityksen (`groups.py`) kesken.

**Yhteyslooppi** (`run()`):
- Ratkaisee kohteena olevan hostin (identity.server > enrolled server >
  settings).
- `asyncio.open_connection(..., ssl=ctx)`; lukulooppi pilkkoo striimin
  `</event>`-rajoilla (1 s tiketti, jotta dead-link-tunnistus voi keskeyttää
  hiljaisen striimin).
- Kiinteä uudelleenyritys 10 s välein SSL/OSError-tilanteissa; loopin
  sisäiset virheet myös retryävät.
- Jokaisen saapuvan tapahtuman reititys:
  - Sisältää `b-t-f-d`/`b-t-f-r` → kuittausten käsittely (parse, broadcast
    `chat_receipt` käyttäjän välilehdille).
  - Sisältää `b-t-f` → chatin parsinta, `__chat`-peili tulevia kuittauksia
    varten, `b-t-f-d`-toimituskuittauksen lähetys ellei kyseessä oma kaiku,
    lähettäjän kontaktitiedon päivitys, työntö ketjuhistoriaan + broadcast.
  - Sisältää `t-x-d-d` → poistotehtävän parsinta (vaatii täyden
    link-tripletin uid/relation/type; ohittaa oman UID:mme), kontaktin +
    ketjun siivous, ilmoitus frontendille `cot_delete`-viestillä.
  - Muuten → `parse_cot()`; atomit (tyyppi alkaa `a-`, plus kaikki tapahtumat,
    joissa on `<emergency>`) muuttuvat throttlatuiksi/minifioiduiksi
    karttapäivityksiksi ja päivittävät kontaktirekisteriä, kun ne kantavat
    callsign + endpoint -kenttiä.

**Keepalive** (`_heartbeat_loop`, spektä johdetut vakiot):
`RX_STALE_SECONDS=15`, `PING_INTERVAL_SECONDS=4.5`, `RX_DEAD_SECONDS=25`,
`SA_INTERVAL_SECONDS=30`. SA-sijaintiraportti lähetetään heti yhdistettäessä
ja päivitetään 30 s välein; `t-x-c-t`-pingit alkavat, kun saapuva liikenne
hiljenee; 25 s hiljaisuuden jälkeen yhteys julistetaan kuolleeksi ja
muodostetaan uudelleen.

**Lähtevät tapahtumat**: SA-raportti (`a-f-G-U-C` kentällä
`endpoint="*:-1:stcp"`, jotta muut tulkitsevat meidät geochat-kykyiseksi,
`__group`-väri/rooli, `takv`-platform WebView), ping, self-delete
(`t-x-d-d` `p-p`-linkillä omaan UIDimme) siivulla stopissa.

**CoT-parsinta** (`parse_cot`): lxml → litteä dict (uid, type, how, callsign,
lat/lon/alt pyöristettynä, ce, stale, battery, group name/role, course/speed,
remarks, link_url, argb-väri, iconsetpath, `__milsym`/`__milicon`, squawk
contact@track-kentästä tai remarks-regexistä, xmpp/mail/phone,
emergency-objektti ml. cancel, staff_comment-osuma konfiguroiduista
kuvioista).

**Geochat**:
- Ketjut avaimena `chatgrp id` (vertaisen UID DM:issä, muuten huoneen nimi);
  rajattu historia: 200 viestiä/ketju, 50 ketjua (LRU ajan mukaan).
- `parse_chat` erottaa DM:n ja huoneen parent/TeamGroups/chatgrp-muodosta
  ja ratkaisee lähettäjän kutsimerkin (attribuutti > remarks source -
  haku > link uid).
- `send_chat` validoi tekstin (≤4000 merkkiä), rakentaa ATAK 5.8 -muotoisen
  tapahtuman, lisää `<marti><dest uid>` DM:ille (palvelinpuinten 1:1-
  reititys; palvelin stripaa elementin toimituksessa), peilaa viestin
  paikallisesti lipulla `self=True`; `client_id` (frontendin UUID) muuttuu
  `messageId`:ksi mahdollistaen optimistisen lähetyksen deduplikoinnin.
- Kuittaukset: vastaanotetut viestit snapshotoidaan
  `_receipts[messageId] = mirror`; toimituskuittaus (`b-t-f-d`) lähetetään
  automaattisesti vastaanotossa; `send_chat_read` (WS `chat_read`-
  laukaisema) lähettää `b-t-f-r`:n kerran per viesti (`_read_sent`-dedup).
- `chat_snapshot()` antaa tuoreelle välilehdelle koko tilan (`chat_init`);
  `reset_chat()` tyhjentää tilan, kun aktiivinen käyttäjä vaihtuu.

**Broadcast-putki** (`_broadcast_if_needed`): per-UID TTL-throttle
(poikkeus: aktiiviset hälytykset), avainten minifiointi `KEY_MAP`illa
(uid→i, lat→la, …), MessagePack tai JSON, broadcast rajattuna omistavan
käyttäjänimeen.

### 5.5 `app/clients.py` — ClientPool

`dict[(server, username) -> TAKClient]`. `client()` luo tarvittaessa ja
päivittää aina identiteetin (joten konfiguraatiomuutokset poimitaan ilman
uutta pool-merkintää); kytkee `on_cot = client._broadcast_if_needed`.
Lisäksi `client_for(username)`, `is_running`, `stop_user`, `stop_all`.

### 5.6 `app/connection.py` — WS-hubi + sessioseurain

- `ConnectionManager`: mapaa live-WebSocketit → käyttäjänimi.
  `broadcast(payload, username=None)` jakaa kaikille yhden käyttäjän
  välilehdille (monikäyttäjäeristys); `None` tarkoittaa kaikille (legacy).
  Epäonnistuneet lähetykset pudottavat socketin rekisteristä.
- `SessionTracker`: auktoritatiivinen RAM-mappaus sid→username, joka
  rekisteröidään loginissa/enrollissa/tuonnissa, per-sid-WS-laskurit ja
  käänteinen indeksi username→sidit. Jokainen autentikoitu HTTP-endpoint
  käyttää sitä (`tracker.username_for(sid)`), samoin logout-logiikka
  havaitsemaan "viimeinen sessio meni".

Molemmat singletoneita: `manager`, `tracker`.

### 5.7 `app/groups.py` — Kanavat (Marti-välitys)

Puhuu TAK-palvelimen klassisen authin ryhmä-API:lle kirjautuneen käyttäjänä
(mTLS hänen omalla sertifiikillaan/avaimellaan
`build_ssl_context_for_user`-funktion kautta):

- `GET /Marti/api/groups/user?username=` → oikeuslista; jokainen merkintä
  on `(name, direction, active)`-tripletti (IN = vastaanotto, OUT = lähetys).
- `channels_from_entitlements()` redusoi tripletit muotoon
  `{name, subscribed}`, jossa subscribed = *kaikkien* saatavilla olevien
  suuntien active-tila.
- `set_subscribed_channels()` toteuttaa **absoluuttisen** PUT-semantiikan:
  hakee oikeudet uudelleen ja lähettää halutun osajoukon täydellisenä
  aktiivisena joukkona (pois jätetyt nimet menevät inaktiivisiksi
  palvelimella).

### 5.8 `app/main.py` — FastAPI-sovellus

Lifespan: lataa kerrokset/iconsetit käynnistyksessä, pysäyttää kaikki
clientit shutdownissa. Middleware: allekirjoitettu sessioeväste
(`tak_webview_session`, sessioscope), salliva CORS. Staattiset mountit
iconseteille ja frontend-distille.

Endpointit:

| Reitti | Tarkoitus |
| ------ | --------- |
| `GET /health` | Liveness-probe (suodatettu access-lokeista) |
| `GET /api/auth/status` | enrolled/authenticated-liput, cert-tiedot, pinned/forced server |
| `POST /api/auth/enroll` | Enrollment; palauttaa palvelinprofiilin esitäyttöä varten |
| `POST /api/auth/upload-p12` | Manuaalinen cert-tuonti |
| `POST /api/auth/login` | Salasanalogin; 3 epäonnistumista → wipe |
| `POST /api/auth/logout` | Säilyttää certit, pysäyttää clientin kun viimeinen välilehti sulkeutuu, pudottaa RAM-avaimen |
| `POST /api/auth/logout-wipe` | Poistaa tämän käyttäjän datan kokonaan |
| `POST /api/messaging/config` | Tallentaa callsign/color/role'n; käynnistää tai päivittää käyttäjän TAK-clientin |
| `GET /api/messaging/config` | Tallennettu konfiguraatio + tilin lat/lon |
| `POST /api/messaging/location` | Tallentaa oman sijainnin; päivittää live-identiteetin paikallaan (ei reconnectia) |
| `GET /api/channels` | Listaa kanavat + yhdistetyntilaustilan |
| `PUT /api/channels` | Asettaa valitun kanavajoukon |
| `GET /config` | Koostettu frontend-konfiguraatio (`layers.get_app_config`) |
| `GET /iconsets`, `GET /logo`, `GET /api/overlays/{file}` | Assetit |
| `WS /ws` | Autentikoitu datasocket (alla) |

Moduulitason `messaging_config: dict[username, {callsign,color,role}]` on
RAM-only ja tyhjenee aina kun auth-konteksti vaihtuu
(`reset_messaging_config` enrollissa/tuonnissa/logout-wipessa) — tämä
takuu sen, ettei TAK-client voi käynnistyä automaattisesti ennen
eksplisiittistä vahvistusta.

**WebSocket-protokolla** (`/ws`): vaatii session authin + tunnetun sid:n;
avaautuu `chat_init`-snapshotilla; hyväksyy sitten `chat_send`- ja
`chat_read`-JSON-viestit ratkaisemalla käyttäjän TAK-clientin *per viesti*
(lazy-start hoitaa tapauksen, jossa konfiguraatio vahvistettiin yhteyden
jälkeen); virheet pintaantuvat `chat_error`-viesteinä. Saapuvat broadcastit
saapuvat minifoituina CoT-dicteina, `cot_delete`, `chat`,
`contacts_update`, `chat_receipt`. Katkaisussa, kun käyttäjällä ei ole
enää välilehtiä, hänen TAK-clientinsä pysähtyy.

---

## 6. Frontend-moduulit tarkemmin

### 6.1 `index.html`

Yhden sivun kuori (~1675 riviä ml. CSS). Pääalueet:

- **Auth-overlay** (`authOverlay`): valikkoruutu (Enroll / Upload / Login),
  enrollment-lomake, upload-lomake (heikon salasanan "new password" -
  kontti), login-lomake, server-info-banneri kiinnitetyn palvelimen nimestä.
- **Tilapalkki** (`statusBar`): yhteysosoitin, Zulu-kello, cert-org +
  vanheneminen (värikoodattu), identiteetti (`statusUser`),
  oman sijainnin nappi + valitsin, `configStatusBtn` (viestintäkonfiguraatio),
  `channelsStatusBtn` (kanavat-ikkuna), chat-toggle lukumerkinsimellä,
  logout/forget -napit.
- **Sivupalkki**: näkymävalinnat (show-callsigns-checkbox),
  suodatinsyötöt (teksti, affiliaatio-VirtualSelect,
  dimensio-VirtualSelect), track-lista (`unitListContent`,
  laskostettava kategoria/affiliaatio-puu), staff comment -ryhmät.
- **Kerrosvalitsinpaneeli**: peruskarttagridi, overlaygridi,
  terrain-osa, analyysi (korrokäyrät) -osa eteenpäin/taaksepäin-stepperillä.
- **Modaalit**: overlay-tyyliteditori, info-modaali, viestintäkonfiguraation
  overlay (`configOverlay`), kanavat-overlay (`channelsOverlay`).
- **Chat-paneeli** (`chatPanel`): kanavalista (Rooms/Users), ketjunäkymä,
  composeri.

### 6.2 `main.js` — käynnistys ja UI-orkestrointi

- `init()` → `checkAuth()` (hakee `/api/auth/status`, päättää näytetäänkö
  auth-overlay vai käynnistetäänkö sovellus) → `startApp()` (loadConfig,
  i18n, viewer, tilanhallinta, eventit, kerrosvalitsin, GoTo-napit,
  localStorage-tilan palautus, WebSocketin käynnistys, initChat,
  oman sijainnin init).
- Auth-virrat: enrollment/upload/login/logout/forget -käsittelijät;
  palvelinkiinnitys piilottaa server-syötöt ja näyttää kiinnitetyn nimen;
  enrollment-profiili esitäyttää viestintäkonfiguraation overlayn.
- **Viestintäkonfiguraation overlay-logiikka**: pakollinen callsign-esto,
  tallennus POST:na `/api/messaging/config` (käynnistää TAK-clientin),
  localStorage-persistenssi per käyttäjänimi scopeattuna
  (`messagingConfig.<user>`).
- **Kanavat-ponnahdusikkuna**: avautuu aina tuoreella `GET /api/channels`,
  piirtää yhden checkboxin per kanava, `PUT /api/channels` valituilla
  nimillä tallentaessa.
- Kerrosvalitsimen rakennus, overlay-tyylimodaali, korrokontrollit,
  suodatinjohdotus, Zoom-to-All (theater-säteen poikkeamakarsinta +
  padding), Reset View (min. 15 km korkeus), valinnan uudelleenreititys
  (`*-course/-trail/-outline` → parent-entiteetti), hashtag-suodatinlinkit
  Cesium InfoBox iframe:ssa, välilehden näkyvyyden render-pause,
  kameran move-autosave.
- **Oma sijainti**: canvas-kolomiarkeri, karttaklikkaus ScreenSpaceEvent-
  Handlerilla tai selaimen geolokaatio, persistenssi localStoragessa
  ja työntö `POST /api/messaging/location`.

### 6.3 `state.js` — entiteettitilahallinta

Keskusvarasto `entityState: {uid -> state}`, jossa state pitää JS-puolen
datan (`lastData`, position/historia, viittaukset jopa kolmeen Cesium-
entiteettiin: pää-billboard+label, `-trail`-polyline, `-course`-nuoli)
sekä kirjanpitoflagit.

Keskeiset mekanismit:

- **Lykätty reconcilaatio**: saapuvat päivitykset mutatoivat vain JS-tilaa;
  varsinainen Cesium-työ tapahtuu joko heti (välilehti näkyvissä;
  foreground-jono, 50 ms throttlatut batchit) tai lykätään flagilla
  `_pendingCesiumReconcile` välilehden palatessa näkyviin. Render-looppi
  pysähtyy kokonaan, kun välilehti on piilossa
  (`viewer.useDefaultRenderLoop = false` main.js:ssä).
- **Poistoputki**: looginen poistomerkintä → välitön piilotus → batchattu
  poistojono animaatioframeilla (suspend/resume eventit, valitun/seuratun
  entiteetin batch-deselect, tilaobjektin poisto lykättynä seuraavaan
  frameen). "Resurrektio": päivitys kesken purkamisen peruu poiston.
- **Ikonigeneraatio**: cache avaimella
  `sidc-color-squawk-staff_comment` (tai joukkueympyrä/iconset-variantit);
  milsymbol-canvas → blob-URL referenssimääritetyllä blobien vapautuksella
  (`iconCache`, `blobUsageRegistry`, `pendingIcons`-promise-dedup).
  Joukkueympyrät (`drawGroupIcon`) piirtävät TAK-värilevyn roolilyhenteellä;
  GPS-modifier-viiva estetään live-SA:lle (`how === "m-g"`).
- **Näkyvyysmoottori**: teksti/affiliaatio/dimensio-suodattimet
  (`calculateVisibility`, affiliaationormalisointi a→f, j/k→h, p/o→u),
  DistanceDisplayConditionit kaltevuuden ja valinnan mukaan, trailit
  näkyvät vain valittuina + suodattimien läpäisyssä, callsign-masterkytkin.
- **Yksikkölista & staff commentit**: ryhmitellyt HTML-listat
  (Incidents/Aircraft/Vessels/Other UID-heuristiikoilla gdacs/icao/#adsb/
  ais/#ais, sitten affiliaatio), laskostettavat `window.toggleCollapse`illa,
  zoom `window.zoomToUnit`illa; staff comment -määrittelyt parsitaan
  `appConfig.tak_staff_comments`istä ja matchataan per entiteetti
  `staffCommentMapiin`.
- **Stale-sweep**: kello-tick ~30 s välein poistaa entiteetit, joiden
  stale-aikailmoituksesta on kulunut yli 120 s.

Minifioitujen avainten käänteismuunnos tapahtuu `updateEntity`ssä
`REVERSE_KEY_MAP`illa.

### 6.4 `viewer.js` — Cesium-skene

- `initViewer()`: token-setup, OSM-fallback-peruskartta, minimi chrome,
  ellipsoidi-terrain, aloituspiste konfiguraatiosta, depth-test terrainia
  vasten, Zulu-kello.
- Imagery-tarjoajat: WMS (WebMercator, transparent PNG), XYZ/TMS-template,
  ArcGIS MapServer; valinnainen rectangle konfiguraatiosta tai tunnistetusta
  extentistä; manuaaliset attribution-creditit.
- Terrain-vaihto + korroportin gateeraus (korrokäyrät vaativat terrainIN JA
  tumman peruskartan — `checkAnalysisAvailability` pakottaa UI-osion
  piiloon).
- Overlayt: tiedostodatasourcet (GeoJSON/KML/CZML) clampattuna maahan,
  pickable, tyyliteltynä `localStorage["overlay_style_<layer>"]`istä —
  ääriviivapolylinet erillisinä entiteetteinä (natiivit polygon outlines
  eivät clamppaa), dashed/dotted-materiaalit, täyttöväri/läpinäkyvyys,
  maantieteellisen keskipisteen labelit `Rectangle.fromCartesianArray().
  center` -funktiolla etäisyys skaalatussa renderöinnissä.
- Kamera/kerros -tilan getterit sessiopersistenssiä varten.

### 6.5 `chat.js` — chat-paneelin UI

Tila: `contacts`-Map, `threads`-Map (avain → messages/unread/kind),
`pendingIds` (dedup), `receiptStatus`, `readSignaled`, `roomIconCache`.

- `handleChatInit` hydratoi `chat_init`istä; `insertMessage` deduppaa
  optimistiset lähetykset `message_id`llä (kääntää `pending`n pois
  lisäämisen sijaan), laskee lukemattomat, triggeröi lukukuittaukset
  avoimelle ketjulle.
- `buildSystemRooms`: "All Chat Rooms" + yksi huone per näkyvä joukkueväri +
  yksi per ei-member-rooli (oma mukaan); yhdistetty live-huoneketjujen kanssa
  funktiossa `roomChannelList`; ikonit piirretty canvakselle (värikielet,
  roolimonogrammit, forum-glyph).
- Users-osa listaa DM-ketjut *plus* kontaktit ilman ketjua (DM:n aloittaminen
  kontaktille ilman historiaa toimii — `contacts.get(threadKey)`-polku
  funktiossa `sendMessage`), jokainen näyttää kontaktin live-karttaikonin
  (`getEntityIconUrl`), päivittyen `cot-icon-ready`-eventissä.
- Lähetys on optimistinen: paikallinen pending-kupla + `ws.send({chat_send})`;
  kuittaukset renderöityvät ✓/✓✓ funktiolla `statusCheckmark`.
- `escapeHtml` käytössä johdonmukaisesti kaikille injektoituille merkkijonoille.

### 6.6 Tukevat moduulit

- `websocket.js`: yhdistää `/ws` (binaryType arraybuffer), dekoodaa msgpackin
  tai JSONin, dispatchaa state/chat-moduleille, statuspisteen pulssi,
  4001 = unauthorized (ei reconnectia, näyttää authin), muuten 5 s auto-
  reconnect.
- `config.js`: `/config`-haku jaettuun mutatoituvaan `appConfig`iin; i18n-
  JSON-lataus kielifallback-ketjulla; staattinen DOM-käännöskierros.
- `utils.js`: `cotToSidc` (CoT-2525-mappaus), `cleanSIDC2525C` (wildcard/SOF-
  normalisointi), MGRS-konversio, affiliaatiovärit/labelit, squawk-hätä-
  labelit, great-circle-destination-matematiikka, geneerinen throttle,
  Google-Material-tyylinen canvas-ikonirenderöijä.

---

## 7. Datan virtaukset

### 7.1 Login → ensimmäinen karttapäivitys

1. Selain: `POST /api/auth/login` → tausta varmistaa PBKDF2-hashin, luo
   RAM-`UserSession`in (Fernet-avain), rekisteröi `sid→username`, asettaa
   sessioevästeen.
2. Frontend ajaa `init()`in uudelleen; `GET /api/messaging/config` tyhjä →
   konfiguraatio-overlay pakottaa callsign/color/role -syötön.
3. `POST /api/messaging/config` → `pool.client(server, username, identity)`
   luodaan; `client.start()` → TLS-yhteys (memfd-syötetty cert/avain),
   SA-raportti lähetetään, heartbeat käy.
4. Selain avaa `/ws`:n; hubi taggaa socketin käyttäjänimellä; tausta lähettää
   `chat_init`in; saapuvat CoT-atomit virtaavat: parse → throttle → minify →
   msgpack → `manager.broadcast(username=...)` → `updateEntity()` →
   reconcile → billboard ilmestyy.

### 7.2 Chat-viestin lähettäminen

Frontend `sendMessage()` → optimistinen kupla →
`chat_send{room?, peer_uid?, peer_callsign?, text, client_id}` `/ws`:n yli →
tausta ratkaisee käyttäjän clientin per viesti → `send_chat()` rakentaa
`b-t-f`-viestin (DM lisää `<marti><dest uid>`), kirjoittaa TLS-striimiin,
peilaa viestin ketjuhistoriaan ja takaisin kaikille välilehdille lipoilla
`self=true` ja samalla `message_id`llä → frontend kääntää pendingin pois.
Vastaanottopuoli: palvelin toimittaa `b-t-f`-viestin → `parse_chat` →
toimituskuittaus `b-t-f-d` takaisin lähettäjälle → vastaanottajan välilehdet
saavat `chat`-viestin; kun he avaavat ketjun, `chat_read` → `b-t-f-r` →
lähettäjän checkmark päivittyy ✓→✓✓.

### 7.3 Kanavatilaus

Tilapalkki → "Channels" → `GET /api/channels` → `groups.py` rakentaa mTLS-
kontekstin käyttäjän RAM-dekryptatusta avaimesta, GETtaa `/groups/user`in,
yhdistää IN/OUT:n per nimi → checkboxit. Save → `PUT /api/channels`
valituilla nimillä → tausta hakee oikeudet uudelleen ja PUTtaa absoluuttisen
aktiivisen joukon osoitteeseen `/Marti/api/groups/active`.

### 7.4 Entiteetin poisto

Etäasiakas katkaisee yhteyden → palvelin emittoi `t-x-d-d`-tapahtuman,
joka linkittää UID:n → tauesta siivoaa kontaktin + DM-ketjun, broadcastaa
`cot_delete`-viestin → frontend poistaa karttaentiteetin (`removeEntity`)
ja chat-kontaktin/DM:n (`handleCotDelete`).

### 7.5 Logout / teardown

- Tavallinen logout: viimeisen välilehden `/ws`-sulkeminen triggeröi
  `pool.stop_user`-kutsun (soft `t-x-d-d`, joka vanhentaa SA-pistemme);
  viimeisen session päättyminen pudottaa RAM-storage-avaimen.
- Logout-wipe lisäksi poistaa käyttäjän rekisterihakemiston, nollaa
  viestintäkonfiguraation ja nollaa palvelinpinin, mikäli kyseessä oli
  viimeinen cert.

---

## 8. Tietoturvamalli

- **Levolla**: yksityiset avaimet Fernet(AES128-CBC)-salattuna; storage-avain =
  PBKDF2(salasana, salt). Tili tallentaa vain hash+saltin. Mikään selväkielinen
  ei koske levyleä hakemiston `/app/certs/ephemeral` alla.
- **RAMissa**: puretut avaimet vain TLS-kontekstin rakentamisen aikana;
  syötetään anonyymien `memfd`-kuvausten kautta, jotka suljetaan heti
  `load_cert_chain`-kutsun jälkeen.
- **Transport**: selain↔tausta on tavallista HTTP:tä sen välityspalvelimen
  takana, jonka operaattori tarjoaa (README suosittelee reverse proxy + TLS);
  tausta↔TAK-palvelin on aina mTLS. Ilman CA-kimpua palvelinsertifikaattia
  ei tarkisteta (`CERT_NONE`) — tuotannossa CA toimitettava.
- **Pääsynhallinta**: jokainen autentikoitu reitti ratkaisee käyttäjän
  palvelinpuolen `sid`:llä (pelkkä evästeen arvo on hyödytön ilman
  allekirjoitusavainta); WebSocket vaatii saman; broadcastit eivät koskaan
  ylitä käyttäjärajoja.
- **Vääryysrajoitukset (nykytila)**: 3 epäonnistunutta loginia whitetää
  tilin tiedot; salasanavahvuuden valvonta tuonnissa; syötteiden validointi
  värien,   roolien, koordinaattien, kanavalistojen ja chat-pituuden osalta.
  Rate limitingiä ja IP-bannausta **ei ole vielä toteutettu**.
- **Yksityisyys**: UID on username-suolanaton hash; tilapalkki näyttää cert-
  organisaation eikä CN:tä; käyttäjänimet eivät lähde taustasta ulos paitsi
  Marti API -kutsuissa, jotka niitä vaativat.

---

## 9. Konfiguraatioviite

Katso README.md täydelliset ympäristömuuttujataulut (yhteys, identiteetti,
tietoturva, kartta/UI, liikenne/chat/logging, portit). Arkkitehtuurisesti
merkittävimpien yhteenveto:

- `TAK_HOST` / `TAK_PORT` (8089) — CoT-striimin kohde.
- `TAK_API_PORT` (8443) — Marti REST API (kanavat).
- `TAK_ENROLL_PORT` (8446) — enrollment.
- `FORCE_SERVER` — asennuslaajuinen palvelinkiinnitys.
- `WS_THROTTLE` (0.5 s) / `USE_MSGPACK` — frontend-liikenteen muotoilu.
- `LOG_COTS` — langan loggaus (nostaa tak/main-loggerit DEBUG-tasolle).
- Kiinteät konttipolut: `/app/certs/ephemeral`, `/iconsets`,
  `/app/user_iconsets`, `/app/overlays`.

---

## 10. Testit ja työkalut

Tausta (`poetry run pytest` hakemistosta `backend/`, asyncio-tila auto):

| Tiedosto | Kattaa |
| -------- | ------ |
| `test_config.py` | Settingsten parsinta/validointi |
| `test_cot_parsing.py` | `parse_cot` XML→dict |
| `test_users.py` | Rekisteri + kryptoprimitiivit |
| `test_clients.py` | ClientPool-elinkaari |
| `test_multiuser.py` | Käyttäjäkohtainen eristys |
| `test_server_pinning.py` | FORCE_SERVER/pin-päätökset |
| `test_chat_roundtrip.py` | Chatin build/parse-symmetria |
| `test_chat_receipts.py` | b-t-f-d/b-t-f-r-käsittely |
| `test_groups.py` | Oikeuksien yhdistäminen + PUT-runko |

Frontend: Vitest (`npm test`), ESLint + Prettier (`npm run lint/format`),
Vite-build (`npm run build`).
Python-laatuportit: black, mypy (strict), pylint, ruff.

Docker: vaihe 1 builddaa frontendin Nodella, vaihe 2 asentaa Poetry-
riippuvuudet python:3.11-slim-imageen, kopioi `backend/app`in, palvelee
`frontend/dist`iä FastAPI:sta, mounttaa iconsetit polkuun `/iconsets`,
exposaa portin 8000.
