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

> Adaptive Thermostat does not connect to any physical device, and is not a branded app. It ships
> no hardware integration at all: both of its drivers create **virtual** devices — one thermostat
> per room, and one central controller.
>
> Its entire purpose is to add a regulation layer on top of devices that belong to *other* apps: it
> reads `measure_temperature` from a sensor owned by one app, and writes `target_temperature` — or
> a valve opening — to a heater owned by another. This is the same shape as Device Groups, which
> your documentation lists as an app that may use this permission.
>
> There is no Apps SDK path to read or write a capability of a device an app does not own. Flow
> cards can only take device arguments filtered to the app's own drivers, and capability listeners
> only apply to the app's own devices. The Web API is the only mechanism, which is why the
> permission is not an optimisation here but the condition of the app existing at all.
>
> The surface used is deliberately minimal and easy to verify. A single module of the whole project
> imports `homey-api` — `runtime/hub.mts` — and it touches exactly two namespaces:
>
> - `api.devices`: `connect`, `disconnect`, `isConnected`, `getDevice`, `getDevices`, and on the
>   returned device objects `makeCapabilityInstance` and `setCapabilityValue`;
> - `api.zones`: `connect`, `disconnect`, `getZones` — used only to show the room name next to a
>   device while pairing.
>
> Nothing else is touched: no flows, no users, no apps, no system, no notifications, no insights,
> no geolocation. The only write is `setCapabilityValue`, and only on capabilities of devices the
> user explicitly selected during pairing. A server-side check re-validates the requested device
> against the same candidate list the pairing view uses, so a crafted call cannot bind an arbitrary
> device.
>
> Following your rule of thumb that this permission belongs to apps categorised under Tools, the
> manifest now declares `"category": ["climate", "tools"]`.
>
> `platforms` is `["local"]`, since the permission is not available on Homey Cloud, and all six API
> endpoints of the app are declared with `"role": "owner"`.

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
