# `runtime/` — couche de câblage

C'est ici, et nulle part ailleurs, qu'on importe `homey` et `homey-api`. Ce répertoire ne prend
aucune décision de régulation : il lit le monde, appelle les réducteurs purs de `lib/`, et écrit
le résultat.

- `hub.mts` — le **seul** module qui importe `homey-api`. Sa première responsabilité est d'appeler
  `await api.devices.connect()` avant tout `getDevices()` : sans ça, `ManagerDevices.scheduleRefresh()`
  ne trouve aucun device en cache et ne rejoue rien après une coupure websocket. Les instances de
  capability continueraient alors de rapporter éternellement leur dernière valeur vue, sans la moindre
  erreur — et la régulation piloterait une chaudière sur des données mortes.
- `mqttBackend.mts` — le **seul** module qui importe `mqtt`. La dorsale Zigbee2MQTT optionnelle
  (SPEC §1.1), activée par les réglages d'app. Elle n'existe que parce que l'app Homey Z2M ne mappe
  aucune des quatre propriétés de vanne dont on a besoin. Trois règles y sont tenues : aucune
  exception ne remonte (le thermostat retombe sur la consigne), aucun appariement approximatif entre
  device Homey et `friendly_name`, et aucune déduplication — elle appartient à l'émetteur, qui seul
  connaît le rappel périodique de la SPEC §5.5. Tout ce qui se décide sans réseau vit dans
  `lib/mqttPayload.mts`.
- `scheduler.mts` — l'unique timer de l'app. Une base rapide, des échéances par device.
- `emitter.mts` — le groupe d'émetteurs d'un VTherm et ses deux dorsales (capability Homey, MQTT).
- `participants` — l'adhérence entre les devices Homey et le noyau.
