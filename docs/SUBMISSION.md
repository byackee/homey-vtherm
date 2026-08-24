# Soumission App Store — argumentaire et texte prêt à coller

Ce fichier n'est pas embarqué dans le bundle (`.homeyignore`).

## Contexte : rejet du build 6 sur `homey:manager:api`

La documentation Athom (Permissions › *Which apps may use the API permission?*) est le texte à
travailler, et il tranche dans les deux sens :

- **En notre faveur.** Les exemples d'apps **autorisées** sont « a DIY Home Alarm system,
  HomeyScript and **Device Groups** ». Device Groups crée des appareils **virtuels** qui agrègent
  et pilotent les appareils d'**autres** apps : c'est exactement notre architecture, en plus
  contraint.
- **Contre nous.** Les exemples refusés sont « those that connect to a **physical device**, e.g. a
  **branded** app for lightbulbs, thermostats etc. » Le mot « thermostats » y figure — mais la
  phrase vise les apps **de marque** qui parlent à du **matériel**. Notre app ne se connecte à
  aucun appareil physique et n'appartient à aucune marque.
- **La règle empirique.** « only apps that add functionality to Homey that can be categorised in
  the **Tools** section, should use the API permission. » ⇒ `category` passe de `["climate"]` à
  `["climate", "tools"]`. C'est la concession concrète à faire valoir dans la réponse.

## Texte à envoyer au reviewer (anglais)

Le reviewer ne demande pas de retirer la permission : « can you please clarify why your app uses
this permission in the next submission ». C'est une question, on y répond — brièvement, sans
plaider.

> Thanks for the review. Happy to explain the API permission.
>
> Adaptive Thermostat doesn't talk to any hardware. Both of its drivers create **virtual** devices —
> one thermostat per room, and one central controller — and the whole app is a regulation layer on
> top of devices that belong to *other* apps: it reads `measure_temperature` from a sensor owned by
> one app, and writes `target_temperature`, or a valve opening, to a heater owned by another. That
> is the only thing it does, and it's closer in shape to Device Groups than to a brand integration.
>
> As far as I can tell there's no Apps SDK route to read or write a capability of a device an app
> doesn't own — Flow card device arguments are scoped to the app's own drivers, and capability
> listeners only apply to its own devices. If I've missed one, I'd genuinely rather use it and
> would be glad to rework the app around it.
>
> The surface is small and easy to check. A single module imports `homey-api` — `runtime/hub.mts` —
> and it uses two namespaces:
>
> - `api.devices`: `connect`, `disconnect`, `isConnected`, `getDevice`, `getDevices`, plus
>   `makeCapabilityInstance` and `setCapabilityValue` on the returned device objects;
> - `api.zones`: `connect`, `disconnect`, `getZones`, only to show the room name next to a device
>   while pairing.
>
> Nothing else: no flows, users, apps, system, notifications, insights or geolocation. The only
> write is `setCapabilityValue`, and only on devices the user picked during pairing — a server-side
> check re-validates the requested device against the same candidate list the pairing view uses.
>
> I've also added Tools alongside Climate in the manifest, which seems closer to how this
> permission is scoped. `platforms` stays `["local"]`, and the app's six API endpoints are all
> `"role": "owner"`.
>
> The readme is rewritten and much shorter now, and points at the Community topic for the details.
> Thanks also for the note on the driver icons — I've requested custom ones on the Homey Vector
> page.
>
> Happy to narrow anything further or walk through any part of the code.

## Les deux autres points du rejet

**README (motif de rejet).** Corrigé : deux paragraphes, texte brut, sans URL ni liste de
fonctionnalités, et `README.fr.txt` / `README.nl.txt` ajoutés. Le reviewer suggère de renvoyer vers
un topic communautaire pour le détail — c'est déjà le cas, `support` et `homeyCommunityTopicId`
pointent dessus.

**Icônes de driver (retour non bloquant).** « Additionally, we have a small point of feedback » : ce
n'est pas un motif de rejet. Le constat est juste — `drivers/central/assets/icon.svg` porte une
flamme en aplat (`fill="#000"`), et les deux icônes sont des formes plates et frontales là où la
guideline 1.6 demande « an angle from the right side ».

Tentative faite et ABANDONNÉE : convertir la flamme pleine en tracé. Mesuré au rendu, l'icône
devenait PIRE — 21,7 % de pixels sombres contre 20,2 %. La flamme fait ~25 unités de large pour un
trait de 7, soit 28 % de sa largeur : le contour empâte au lieu de dessiner. L'icône a été remise à
l'identique.

Le reste — la perspective de trois-quarts — est du dessin d'icône, pas de l'édition de SVG. Suivre
la suggestion du reviewer et demander des icônes sur la page Homey Vector est la bonne voie, et elle
n'empêche pas de resoumettre entre-temps.

## Réserve honnête sur un point que le reviewer peut trouver

`getDeviceSettings` (`runtime/hub.mts:715`) lit les `settings` bruts d'un appareil tiers. C'est
nécessaire pour retrouver le `friendly_name` Zigbee2MQTT d'une vanne, que l'app Zigbee2MQTT range
dans les réglages de l'appareil qu'elle crée, et sans lequel la dorsale MQTT optionnelle ne peut
rien piloter. Seul `extractDeviceHint` en voit le contenu, et il n'en sort que deux chaînes
(`friendly_name`, `ieee_address`) ; rien n'est journalisé ni renvoyé. Si le reviewer objecte, ce
chemin est celui de la fonctionnalité **optionnelle** Zigbee2MQTT et peut être retiré sans toucher
au cœur de l'app.

## Question à anticiper : « core functionality must always work standalone » (1.12)

L'app fonctionne avec n'importe quel appareil portant `measure_temperature` et
`target_temperature`, y compris natif Homey, et ne dépend d'aucune app nommée. Le chemin
Zigbee2MQTT est un supplément : sans lui, la régulation se fait par consigne décalée, et
`runtime/valveBackend.mts` documente cette dégradation comme une exigence de conception.
