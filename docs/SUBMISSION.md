# Soumission App Store — texte prêt à coller

Ce fichier n'est pas embarqué dans le bundle (`.homeyignore`). Il porte les réponses à donner
au moment de la soumission, pour ne pas les réécrire à chaque version.

## Justification de `homey:manager:api`

Le validateur avertit que cette permission déclenche une review renforcée, et la documentation
Athom décourage explicitement de la demander pour une intégration d'appareils. Voici la
justification à joindre, vérifiable ligne à ligne dans le code.

> Adaptive Thermostat ne pilote aucun matériel qui lui appartienne. Ses deux appareils sont
> **virtuels** : un thermostat par pièce et un contrôleur central. Sa fonction unique est de lire
> `measure_temperature` sur un capteur appartenant à une autre app, et d'écrire
> `target_temperature` — ou l'ouverture de vanne — sur un émetteur appartenant à une troisième.
>
> Aucune API du SDK ne permet de lire ou d'écrire la capability d'un appareil qu'on ne possède
> pas. La Web API est la seule voie, et l'app en utilise strictement la surface nécessaire :
> `devices.connect`, `devices.getDevices`, `devices.getDevice`, `makeCapabilityInstance`,
> `setCapabilityValue`, `zones.connect`, `zones.getZones`. Aucune écriture sur les flows, les
> utilisateurs, les apps ou le système.
>
> Un seul module de tout le projet importe `homey-api` : `runtime/hub.mts`. C'est délibéré, et
> l'en-tête du fichier le documente.

Deux choix à ne pas casser en révisant le manifeste, parce qu'ils font partie de cette
justification : `platforms: ["local"]` — la permission n'existe pas sur Homey Cloud — et
`role: "owner"` sur les six endpoints de l'API de l'app.

## Question à anticiper : « core functionality must always work standalone » (1.12)

L'app fonctionne avec n'importe quel appareil portant `measure_temperature` et
`target_temperature`, y compris natif Homey. Elle ne dépend d'aucune app nommée. Le chemin
Zigbee2MQTT est un supplément : sans lui, la régulation se fait par consigne décalée, et
`runtime/valveBackend.mts` documente cette dégradation comme une exigence de conception.

## Catégorie

`climate` est conservée. L'app est fonctionnellement climatique ; la basculer vers `tools` pour
esquiver la friction sur la permission serait moins honnête et moins découvrable. Repli si la
review refuse sur ce seul motif : `["climate", "tools"]`.
