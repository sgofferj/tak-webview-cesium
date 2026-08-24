# Luku 6 — Symbolien tulkitseminen

## Perusteet

Jokainen seurattava kohde kartalla näkyy sotilaallisena symbolina
MIL-STD-2525-standardin mukaisesti — sama symboliikka, jota ATAK ja muut
taktiset järjestelmät käyttävät. Sinun ei tarvitse tuntea standardia
lukeaksesi karttaa:

- **Symbolin muoto** kertoo, mitä se on (jalkaväki, ilma-alus, alus,
  ajoneuvo, esikunta…).
- **Symbolin kehysväri** kertoo, kumman puolella se on:
  - **Syaani/sininen** — omat (friendly)
  - **Punainen** — vihollinen (hostile)
  - **Vihreä** — neutraali
  - **Keltainen** — tuntematon

## Joukkueympyrät (henkilöt)

Verkkoon yhteydessä olevat joukkueen jäsenet näkyvät **värillisinä
ympyröinä** tavallisten sotilaallisten symbolien sijaan. Ympyrän väri on
jäsenen joukkueväri (luku 3), ja ympyrän sisällä oleva roolilyhenne kertoo
hänen funktionsa. Esimerkiksi punaisen joukkueen lääkittäjä ja sinisen
joukkueen johtaja näyttävät tältä:

![Punaisen joukkueen lääkittäjä](../images/team-red-medic.png)
![Sinisen joukkueen johtaja](../images/team-blue-team-lead.png)

| Lyhenne | Rooli |
| ------- | ----- |
| TL | Team Lead (johtaja) |
| MD | Medic (lääkittäjä) |
| SN | Sniper (tarkka-ampuja) |
| FO | Forward Observer (tulituksen johtaja) |
| RO | RTO (viestimies) |
| K9 | Koirapartio |
| PL | Pilot (lentäjä) |
| HQ | Esikunta |

Pelkkä värillinen ympyrä ilman kirjaimia = Team Member (joukkueen jäsen).

## Kutsimerkkilabelit

Jokaisessa symbolissa on sen vieressä pieni label, jossa lukee
kutsimerkki.

- Sivupalkin **Näytä kutsunimet** -valintaruudulla voit piilottaa tai
  näyttää kaikki labelit.
- Labelit mukautuvat zoomaukseen: ne häviävät, kun symbolit ovat liian
  tiheässä, ja palaavat lähennettäessä. Valittu yksikkö pitää labelinsa
  aina.

## Kurssinuolet ja liikeradat

- Pieni **valkoinen nuoli** liikkuvan yksikön vieressä osoittaa sen
  liikkeen suunnan; se kiertää karttanäkymän mukana:

  ![Kurssinuoli](../images/course-arrow.png)

- Kun valitset yksikön, sen viimeaikainen **liikerata** ilmestyy viivaksi.
  Poista valinta piilottaaksesi liikeradan taas.

## Yksikön valitseminen ja tietojen lukeminen

Napsauta mitä tahansa symbolia avataksesi sen infolaatikon. Riippuen
siitä, mitä dataa yksikkö raportoi, laatikko voi sisältää:

- Kutsimerkin ja tyypin
- Sijainnin leveys-/pituuspiirinä **ja MGRS:nä**
- Korkeuden, kurssin ja nopeuden
- Yhteystiedot (radio/XMPP-tunnus, sähköposti, puhelin), jos annettu
- **Akun varauksen** värimittarina (vihreä/oranssi/punainen)
- **Hätätilanneilmaisimet** — transponderikoodit kuten 7700 (HÄTÄTILA),
  7600 (RADIORIKKO), 7500 (KAAPPAUS) näytetään punaisella korostuksena
- Kommenttitekstin, jossa **hashtagit** kuten `#incident-alpha` ovat
  napsautettavia — yhden napsauttaminen suodattaa kartan kaikkiin saman
  tagin kantaviin yksiköihin
- Ulkoisia linkkejä, esimerkiksi alus- tai lentotiedustelupalveluun

Hätätilanteet merkitään myös punaisella merkillä yksikkölistassa.

## Henkilöstökommenttien korostus

Jos järjestelmänvalvojasi on määrittänyt avainsanoja (esimerkiksi `#SF`
Shadow Fleetille), niitä vastaavat kommentit sisältävät yksiköt
korostetaan ja ryhmitellään sivupalkin **Henkilöstön kommentit** -osioon
(luku 7).
