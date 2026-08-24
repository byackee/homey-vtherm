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

Ton : coopératif, pas défensif. Le refus était raisonnable — une app nommée « Thermostat »,
catégorisée `climate`, qui demande la permission la plus large ressemble exactement au motif que le
reviewer est chargé d'arrêter. On commence donc par le reconnaître.

> Thank you for the review, and for flagging this — I understand the concern. An app called
> "Adaptive Thermostat", filed under Climate and asking for the API permission, looks very much
> like the pattern the rule is meant to catch, and I should have explained the architecture up
> front rather than leaving you to infer it.
>
> The app does not connect to any physical device, and it is not a branded app. There is no
> hardware integration in it at all: both drivers create **virtual** devices — one thermostat per
> room, and one central controller.
>
> What it actually does is add a regulation layer on top of devices that belong to *other* apps. It
> reads `measure_temperature` from a sensor owned by one app, and writes `target_temperature` — or
> a valve opening — to a heater owned by another. In that sense it is much closer to Device Groups
> than to a brand integration: it ships no protocol, no pairing with hardware, and no vendor
> dependency.
>
> As far as I can tell there is no Apps SDK route to read or write a capability of a device an app
> does not own — Flow card device arguments are scoped to the app's own drivers, and capability
> listeners only apply to its own devices. If there is an approach I have missed, I would genuinely
> rather use it, and I am happy to rework the app around it.
>
> In the meantime I have tried to make the permission as easy as possible to audit. One module in
> the whole project imports `homey-api` — `runtime/hub.mts` — and it uses two namespaces:
>
> - `api.devices`: `connect`, `disconnect`, `isConnected`, `getDevice`, `getDevices`, and on the
>   returned device objects `makeCapabilityInstance` and `setCapabilityValue`;
> - `api.zones`: `connect`, `disconnect`, `getZones`, only to show the room name next to a device
>   while pairing.
>
> Nothing else is used: no flows, users, apps, system, notifications, insights or geolocation. The
> only write is `setCapabilityValue`, and only on devices the user picked during pairing — a
> server-side check re-validates the requested device against the same candidate list the pairing
> view uses, so a crafted call cannot bind something else.
>
> I have also added Tools alongside Climate in the manifest (`"category": ["climate", "tools"]`),
> which seems closer to how this permission is meant to be scoped. `platforms` is `["local"]`,
> since the permission is not available on Homey Cloud, and the app's six API endpoints are all
> declared with `"role": "owner"`.
>
> Happy to narrow anything further, or to walk through any part of the code that would help.

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
