# Luku 8 — Kartat, lisäkerrokset ja maasto

Avaa **kerrosvalitsin**-paneeli säätääksesi, mitä kartalla näkyy
yksikkösymbolien alla.

## Pohjakartan valinta

**Pohjakartat**-osio listaa käytettävissä olevat pohjakartat kuvakkeina,
ryhmiteltyinä kategorioittain (esimerkiksi *Maailmankartat* tai
joukkueenne lisäämät kansalliset karttasetit). Napsauta vaihtaaksesi.
Valintasi muistetaan ensi kertaa varten.

## Lisäkerrosten kytkeminen päälle ja pois

**Lisäkerrokset**-osiossa on ruudukko ylimääräistä tietoa, joka piirretään
kartan päälle:

- **Web-lisäkerrokset** — läpikuultavia kerroksia kuten merimerkit,
  ulkoisilta palvelimilta.
- **Paikalliset tiedostot** — joukkueenne oma kartta-aineisto (GeoJSON,
  KML), listattuna nimillään. Näihin voi sisältyä aluerajoja, reittejä,
  kiinnostavia kohteita ja vastaavaa.

Napsauta lisäkerrosta kytkeäksesi sen päälle; napsauta uudelleen
kytkeäksesi pois. Ø-symbolin ruutu kytkee kaiken pois yhtäkkiä.

## Paikallisten tiedostolisäkerrosten tyylittely

Napsauta paikallista tiedostolisäkerrosta hiiren oikealla näppäimellä
avataksesi sen tyylikäsittelijän. Voit muuttaa:

- **Viivan värin, leveyden ja tyyliä** (jatkuva, katkoviiva, pisteviiva) —
  tai piilottaa reunuksen kokonaan
- **Täyttövärin ja läpinäkyvyyttä** — tai jättää täytön pois

Napsauta **Tallenna** ottaaksesi käyttöön. Tyylit säilyvät kerroksittain
selaimeesi, joten värisi palaavat seuraavallakin kerralla.

Polygonit labeloidaan nimellään niiden keskikohtaan automaattisesti,
joten tunnistat alueet avaamatta niitä.

## Maasto

Jos järjestelmänvalvojasi on määrittänyt korkeusmallin, **Maasto**-osiossa
on kaksi valintaa: tasainen (**WGS84 Ellipsoidi**) tai oikea maasto
(**Terrain**) vuorineen ja laaksoineen. Oikea maasto tekee selvän eron
3D-näkymässä työskenneltäessä.

## Korkeuskäyrät

Maaston ollessa käytössä ja tumman pohjakartan ollessa päällä ilmestyy
**Analyysi**-osio: korkeuskäyrät piirrettynä suoraan maastoon syaanilla.

![Korkeuskäyrät-vaihtoehto](../images/contours-thumbnail.png)

Käytä −/+ -askellinta vaihtamaan käyräväliä (esimerkiksi 50 metrin välein
tai 200 metrin välein). Korkeuskäyrät sammuvat automaattisesti, jos
vaihdat vaalealle kartalle tai takaisin tasaiseen maastoon.

> **Miksi vain tummat kartat?** Korkeuskäyrät on kalibroitu tummia
> kuvamateriaaleja vasten; vaaleilla kartoilla ne olisi vaikea lukea,
> joten valinta piilottuu itsestään.

## Tummat kartat

Pohjakartat, joiden nimessä on "dark" tai "night", vaihtavat koko skenen
yöpukuluotuksi — musta tausta, ei ilmakehän hehkua. Hyödyllistä
hämäräoloissa toimittaessa.
