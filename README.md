# Adaptive Thermostat — app Homey

Transforme n'importe quel capteur de température et n'importe quel émetteur de chaleur en un
thermostat qui **régule vraiment** : algorithme proportionnel, presets, détection d'ouverture de
fenêtre, présence et mouvement, et pilotage d'une chaudière centrale sur la demande agrégée.

Portage sur Homey des algorithmes de [Versatile Thermostat](https://github.com/jmcollin78/versatile_thermostat)
(Jean-Marc Collin, MIT). **Cette app ne se connecte pas à Home Assistant** — c'est une
réimplémentation indépendante. Voir `LICENSE` pour l'attribution.

## Pourquoi

Une vanne thermostatique régule sur son propre thermomètre, collé au radiateur : elle lit 25 °C
quand la pièce est à 21. Un thermostat qui coupe et rallume en tout-ou-rien fait osciller la pièce.
Cette app place un vrai régulateur proportionnel entre un capteur qui mesure la bonne température et
un émetteur qui, lui, ne sait pas où il est.

## État

En développement. Le cœur algorithmique est écrit et testé ; la couche Homey est en cours.

- `docs/SPEC.md` — cahier des charges normatif, avec les écarts assumés par rapport à Versatile Thermostat
- `docs/PLAN.md` — plan d'implémentation et risques

## Architecture

```
lib/       cœur PUR — aucun import de Homey, testable par `node --test` sans matériel
runtime/   couche de câblage — le seul endroit qui importe homey / homey-api / mqtt
drivers/   devices Homey, qui ne font que brancher runtime/ sur le noyau
```

La frontière est imposée par le compilateur : `tsconfig.test.json` ne compile que `lib/` et `test/`.
Un import de Homey qui s'égare dans `lib/` casse `npm test` immédiatement.

## Développement

```sh
npm install
npm run typecheck        # tsc sur l'app et sur la suite de tests
npm test                 # cœur pur, sans Homey
npm run validate         # homey app validate --level debug
npm run validate:publish # homey app validate --level publish
npm run app:run          # exécute sur un Homey connecté
```

## Deux dorsales

- **Homey** (toujours active, sans configuration) — régule par consigne décalée sur n'importe quel
  appareil portant `target_temperature`.
- **Zigbee2MQTT** (optionnelle) — si l'accès au broker est renseigné, débloque le contrôle direct de
  l'ouverture de vanne et l'injection de la température de pièce dans la vanne. Ces deux propriétés
  n'existent pas comme capabilities Homey : l'app Zigbee2MQTT ne les mappe pas.
