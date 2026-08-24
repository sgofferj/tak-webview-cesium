# Luku 7 — Yksiköiden löytäminen

## Yksikkölista (Aktiiviset kohteet)

Sivupalkin **Aktiiviset kohteet** -osio listaa kaiken, mikä on tällä
hetkellä näkyvissä kartallasi, järjestettynä nopeaa silmäilyä varten:

- Ylin taso: kategoriat — Tapahtumat (Incidents), Lentokoneet (Aircraft),
  Alukset (Vessels) ja Muut kohteet (Other).
- Kunkin kategorian sisällä: ryhmiteltynä kuuluvuuden mukaan
  (Omat, Vihollinen, Epäilty, Neutraali, Tuntematon).
- Jokainen merkintä näyttää yksikön ikonin ja kutsimerkin sen
  näyttövärillä; aktiiviset hätätilanteet saavat punaisen merkin.

Napsauta kategoriaotsikkoa taittaaksesi tai avataksesi sen. Napsauta
yksikköä lentääksesi kartalla sen luo.

## Tekstihaku

Sivupalkin yläreunan hakukenttä suodattaa kaiken reaaliajassa
kirjoittaessasi. Se täsmää seuraaviin:

- Kutsimerkkeihin
- Yksiköiden ID:hin
- Kommenttitekstiin (ml. hashtagit)

Esimerkki: kirjoittamalla `bravo` jätät näkyviin vain yksiköt, joiden nimi
tai kommentit sisältävät sanan "bravo". Tyhjennä kenttä (tai paina
**Tyhjennä**-nappia) näyttääksesi kaiken.

## Suodatus kuuluvuuden mukaan

Kuuluvuusvalikko antaa valita yhden tai useamman puolen — esimerkiksi
näyttää vain omat ja neutraalit tai vain viholliset. Käytä *valitse
kaikki* -valintaa palataksesi nopeasti täyteen kuvaan.

## Suodatus ulottuvuuden mukaan

Ulottuvuusvalikko suodattaa taistelutilan mukaan: Ilma, Maa, Pinta,
Syvyys, Avaruus, Erikoisjoukot tai Muu. Vaihtoehdot muodostuvat siitä,
mitä kartalla juuri nyt on — jos ilma-aluksia ei ole yhteydessä, Ilma ei
ilmesty listalle.

Suodattimet muistetaan: ne säilyvät selaimen sulkemisesta ja palaavat,
kun palaat.

## Hashtagit

Kommenteissa on usein hashtageja (`#patrol-north`, `#sf`). Ne
renderöityvät napsautettaviksi linkeiksi yksikön infolaatikkoon; yhden
napsauttaminen asettaa sen tekstisuodattimeksi ja näyttää hetkessä vain
saman tagia kantavat yksiköt. Tämä on nopein tapa eristää kiinnostava
ryhmä.

## Henkilöstökommentit-paneeli

**Henkilöstön kommentit** -osio ryhmittelee yksiköt järjestelmänvalvojan
määrittelemien avainsanojen mukaan (esimerkiksi `#SF` = Shadow Fleet).
Jokainen avainsana muodostaa oman taittettavan ryhmänsä, jossa on lista
täsmäävistä yksiköistä. Jos siellä ei näy mitään, joko yksikään yksikkö
ei juuri nyt täsmää tai avainsanoja ei ole määritelty — paneeli pysyy
tyhjänä eikä näytä virheitä.

## Mitä "näkyvissä" tarkoittaa

Kaikki listat ja suodattimet toimivat sillä, mitä kartallasi on juuri nyt.
Raportoinnin lopettaneet (vanhentuneet) yksiköt katoavat automaattisesti,
kun niiden data vanhenee, joten lista heijastaa aina ajantasaista kuvaa.
