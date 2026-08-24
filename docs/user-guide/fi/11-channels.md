# Luku 11 — Kanavat

## Mitä kanavat ovat

TAK-palvelimesi järjestää käyttäjät ryhmiin, joita kutsutaan **kanaviksi**
(ATAKissa ne näkyvät ryhminä kuten `Team Lead`, `Restricted` tai joukkueen
omina nimiä). Kanavan tilaaminen tarkoittaa:

- **IN** — kuulet, mitä kyseisellä kanavalla lähetetään
- **OUT** — lähetyksesi tavoittavat kyseisen kanavan jäsenet

Mitkä kanavat saat liittyä, päättää palvelimen järjestelmänvalvoja. Mitkä
niistä todella kuuntelet, on sinun päätöksessäsi.

## Kanavalistan avaaminen

Napsauta tilapalkin **Kanavat**-nappia. Ikkuna listaa jokaisen kanavan,
johon sinulla on oikeus, ja jokaisen vieressä on valintaruutu. Lista
haetaan tuoreena palvelimelta joka avauskerralla, joten se heijastaa aina
ajantasaista tilaa.

- **Rastitettu** = tilattu (kuuntelet ja tavoitat kyseisen kanavan)
- **Rastittamaton** = ei tilattu

Erillistä IN/OUT-kytkintä ei ole — yksi valintaruutu hallitsee molempia
suuntia, mikä vastaa tapaa, jolla kanavia normaalisti käytetään.

## Tilauksen muuttaminen

1. Avaa **Kanavat**.
2. Rastita haluamasi kanavat; poista rastit niistä, joita et halua.
3. Napsauta **Tallenna**.

Muutos vaikuttaa välittömästi palvelimella. Napsauttamalla ikkunan
ulkopuolelle tai painamalla **Peruuta** suljet sen muuttamatta mitään.

> **HUOM!** Kanavasta pois tilaaminen tarkoittaa, ettei sille lähetettyjä
> viestejä enää toimiteta sinulle — ei myöskään niitä, jotka lähetettiin
> ollessasi tilaamatta. Jälkikäteen tuloa ei ole.

## Jos lista ei lataudu

Jos ikkunassa näkyy virhe (*Kanavien lataus epäonnistui*) kanavien sijaan,
karttaohjelma ei saanut yhteyttä TAK-palvelimen hallintaliittymään sillä
hetkellä. Tarkista yhteysosoitin, odota hetki ja yritä uudelleen (luku 13).

## Miten tämä liittyy chat-huoneisiin

Kanavat ovat *palvelintason* tilauksia, jotka perustuvat oikeuksiisi.
Chatin automaattiset huoneet (joukkuevärit, roolit, All Chat Rooms) ovat
*keskustelu*-huoneita, jotka rakentuvat siitä, kuka on juuri nyt paikalla.
Yleensä sinun ei tarvitse koskea Kanavat-ikkunaan, ellei
järjestelmänvalvoja kerro, mitkä kanavat roolisi vaativat.
